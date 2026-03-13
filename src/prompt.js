import { spawn } from "node:child_process";
import { createStreamParser } from "./stream-parser.js";

/** @type {Map<string, { controller: AbortController, proc: import("child_process").ChildProcess, claudeSessionId: string, done: boolean }>} */
const activePrompts = new Map();

/**
 * Send a prompt to a Claude Code session via the CLI's --resume flag.
 * Streams structured JSON chunks back through the onChunk callback.
 *
 * @param {string} dashboardSessionId - The dashboard session ID (for tracking)
 * @param {{ prompt: string, cwd: string, claudeSessionId: string, permissionMode?: string }} opts
 * @param {(chunk: object) => void} onChunk - Called for each stream-json line
 * @param {(result: { code: number | null }) => void} onDone - Called when process exits
 * @returns {AbortController}
 */
export function sendPrompt(dashboardSessionId, { prompt, cwd, claudeSessionId, permissionMode }, onChunk, onDone) {
  // Don't allow concurrent prompts to the same session.
  // Entries linger with done=true during the grace period for hook dedup — that's OK.
  const existing = activePrompts.get(dashboardSessionId);
  if (existing && !existing.done) {
    throw new Error("A prompt is already running for this session");
  }

  const controller = new AbortController();
  // Tracks whether the --resume fallback was triggered. Hoisted outside
  // launchProcess so the flag survives across the retry call.
  let didFallback = false;

  /**
   * Spawn the claude CLI process. When `resumeId` is provided, passes --resume
   * to continue an existing conversation. When null, starts a fresh session.
   */
  function launchProcess(resumeId) {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
    ];

    if (resumeId) {
      args.push("--resume", resumeId);
    }

    // Add permission mode if specified (default omitted = CLI default)
    const validModes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"];
    if (permissionMode && validModes.includes(permissionMode)) {
      args.push("--permission-mode", permissionMode);
      if (permissionMode === "bypassPermissions") {
        args.push("--dangerously-skip-permissions");
      }
    }

    args.push("--", prompt);

    const proc = spawn("claude", args, {
      cwd,
      signal: controller.signal,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    activePrompts.set(dashboardSessionId, { controller, proc, claudeSessionId, done: false });

    const parser = createStreamParser(onChunk);
    let stderrBuffer = "";
    let stdoutRaw = "";
    // Guard against double-firing onDone (e.g. cancel route + close event).
    // Each launchProcess call gets its own fresh flag.
    let doneFired = false;

    const MAX_STDERR = 4096;

    proc.stdout.on("data", (data) => {
      stdoutRaw += data.toString();
      parser.feed(data);
    });

    proc.stderr.on("data", (data) => {
      const text = data.toString();
      stderrBuffer += text;
      if (stderrBuffer.length > MAX_STDERR) {
        stderrBuffer = stderrBuffer.slice(-MAX_STDERR);
      }
      console.error(`[prompt:${dashboardSessionId}] ${text}`);
      onChunk({ type: "stderr", text: text.trim() });
    });

    proc.on("close", (code) => {
      // If --resume failed because the conversation no longer exists,
      // retry as a fresh prompt without --resume. Check both stderr and
      // stdout (the CLI may emit the error in either stream).
      const allOutput = stderrBuffer + stdoutRaw;
      if (code !== 0 && resumeId && !didFallback && /no conversation found/i.test(allOutput)) {
        didFallback = true;
        console.log(`[prompt:${dashboardSessionId}] --resume failed (conversation not found), retrying as fresh prompt`);
        onChunk({ type: "prompt:context-lost", sessionId: dashboardSessionId, reason: "Session expired or not found — starting fresh conversation" });
        onChunk({ type: "system", text: "Session expired — starting fresh prompt in the same project directory." });
        launchProcess(null);
        return;
      }

      if (doneFired) return;
      doneFired = true;

      parser.flush();
      const entry = activePrompts.get(dashboardSessionId);
      onDone({ code, cancelled: entry?.cancelled ?? false, freshSession: didFallback || false });
      if (entry) entry.done = true;
      setTimeout(() => {
        const current = activePrompts.get(dashboardSessionId);
        if (current?.done) activePrompts.delete(dashboardSessionId);
      }, 5000);
    });

    proc.on("error", (err) => {
      if (doneFired) return;
      doneFired = true;

      onDone({ code: null, error: err.message, freshSession: didFallback || false });
      const entry = activePrompts.get(dashboardSessionId);
      if (entry) entry.done = true;
      setTimeout(() => {
        const current = activePrompts.get(dashboardSessionId);
        if (current?.done) activePrompts.delete(dashboardSessionId);
      }, 5000);
    });
  }

  launchProcess(claudeSessionId);

  return controller;
}

/**
 * Cancel a running prompt for a session.
 * Uses SIGTERM first, then escalates to SIGKILL after a timeout
 * in case Claude Code ignores SIGTERM (a known issue).
 * @param {string} dashboardSessionId
 * @returns {boolean} Whether a prompt was cancelled
 */
export function cancelPrompt(dashboardSessionId) {
  const entry = activePrompts.get(dashboardSessionId);
  if (entry && !entry.done) {
    entry.controller.abort(); // sends SIGTERM
    // Escalate to SIGKILL if process doesn't exit within 3s
    const pid = entry.proc?.pid;
    if (pid) {
      const killTimer = setTimeout(() => {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }, 3000);
      entry.proc.once("close", () => clearTimeout(killTimer));
    }
    // Mark done and cancelled so the close handler can report cancelled: true.
    // Mark done immediately so isPromptActive() returns false, but let the
    // process close handler do the actual map deletion to avoid a 3-second
    // window where a new prompt could race in before the old process exits.
    entry.done = true;
    entry.cancelled = true;
    return true;
  }
  return false;
}

/**
 * Check if a prompt is currently running for a session.
 * @param {string} dashboardSessionId
 * @returns {boolean}
 */
export function isPromptActive(dashboardSessionId) {
  const entry = activePrompts.get(dashboardSessionId);
  return entry ? !entry.done : false;
}

/**
 * Get the Claude CLI session ID that was used for --resume when spawning
 * the active prompt for this dashboard session. Returns null if no prompt
 * is active.
 * @param {string} dashboardSessionId
 * @returns {string | null}
 */
export function getPromptSessionId(dashboardSessionId) {
  const entry = activePrompts.get(dashboardSessionId);
  return entry ? entry.claudeSessionId : null;
}

// Re-export git-worktree helpers for backward compatibility with existing route imports
export { deleteBranch, getBranchDiffStats, detectConflicts, removeWorktree, getCurrentBranch } from "./git-worktree.js";

// Re-export swarm functions for backward compatibility
export { spawnSwarmAgent, cancelSwarmAgent, getActiveSwarmAgents, hasActiveSwarmAgents } from "./swarm-manager.js";
