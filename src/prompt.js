import { spawn, execSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { GIT } from "./git.js";

/** @type {Map<string, { controller: AbortController, proc: import("child_process").ChildProcess, claudeSessionId: string, done: boolean }>} */
const activePrompts = new Map();

/** @type {Map<string, { id: string, controller: AbortController, proc: import("child_process").ChildProcess, description: string, status: string, startedAt: number, sessionId: string }>} */
const activeSwarmAgents = new Map();

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

  /**
   * Spawn the claude CLI process. When `resumeId` is provided, passes --resume
   * to continue an existing conversation. When null, starts a fresh session.
   */
  function launchProcess(resumeId) {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--max-turns", "25",
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

    let buffer = "";
    let stderrBuffer = "";
    let stdoutRaw = "";
    let didFallback = false;

    proc.stdout.on("data", (data) => {
      const raw = data.toString();
      stdoutRaw += raw;
      buffer += raw;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          onChunk(msg);
        } catch {
          onChunk({ type: "raw", text: line });
        }
      }
    });

    proc.stderr.on("data", (data) => {
      const text = data.toString();
      stderrBuffer += text;
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
        onChunk({ type: "system", text: "Session expired — starting fresh prompt in the same project directory." });
        launchProcess(null);
        return;
      }

      // Flush remaining buffer
      if (buffer.trim()) {
        try {
          onChunk(JSON.parse(buffer));
        } catch {
          onChunk({ type: "raw", text: buffer.trim() });
        }
      }
      onDone({ code });
      const entry = activePrompts.get(dashboardSessionId);
      if (entry) entry.done = true;
      setTimeout(() => activePrompts.delete(dashboardSessionId), 5000);
    });

    proc.on("error", (err) => {
      onDone({ code: null, error: err.message });
      const entry = activePrompts.get(dashboardSessionId);
      if (entry) entry.done = true;
      setTimeout(() => activePrompts.delete(dashboardSessionId), 5000);
    });
  }

  launchProcess(claudeSessionId);

  return controller;
}

/**
 * Cancel a running prompt for a session.
 * @param {string} dashboardSessionId
 * @returns {boolean} Whether a prompt was cancelled
 */
export function cancelPrompt(dashboardSessionId) {
  const entry = activePrompts.get(dashboardSessionId);
  if (entry && !entry.done) {
    entry.controller.abort();
    activePrompts.delete(dashboardSessionId);
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

/**
 * Slugify a description for use as a git branch name.
 * @param {string} desc
 * @returns {string}
 */
function slugify(desc) {
  return desc
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

/**
 * Get the current branch name of the repo.
 * @param {string} repoDir
 * @returns {string}
 */
function getCurrentBranch(repoDir) {
  try {
    return execFileSync(GIT, ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "main";
  }
}

/**
 * Create a git worktree with a named branch from the given repo directory.
 * Returns { worktreePath, branchName, baseBranch } on success, or throws on failure.
 *
 * @param {string} repoDir - The git repository root
 * @param {string} id - Unique identifier for the worktree
 * @param {string} description - Human-readable description (used to generate branch name)
 * @returns {{ worktreePath: string, branchName: string, baseBranch: string }}
 */
function createWorktree(repoDir, id, description) {
  // Always resolve to a stable base branch — never use an agent/ branch as base,
  // since the current HEAD might be a transient agent worktree branch.
  const currentBranch = getCurrentBranch(repoDir);
  const baseBranch = currentBranch.startsWith("agent/") ? "main" : currentBranch;
  const slug = slugify(description || id);
  const branchName = `agent/${slug}-${id.slice(0, 6)}`;
  const worktreePath = join(repoDir, "..", `.swarm-worktree-${id}`);

  execFileSync(GIT, ["worktree", "add", "-b", branchName, worktreePath], {
    cwd: repoDir,
    stdio: "pipe",
    timeout: 15000,
  });

  return { worktreePath, branchName, baseBranch };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Remove a git worktree checkout but preserve the branch.
 * Retries with a non-blocking delay if the worktree is still locked.
 * @param {string} repoDir - The git repository root
 * @param {string} worktreePath - The worktree to remove
 */
async function removeWorktree(repoDir, worktreePath) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      execFileSync(GIT, ["worktree", "remove", "--force", worktreePath], {
        cwd: repoDir,
        stdio: "pipe",
        timeout: 15000,
      });
      return; // success
    } catch (err) {
      const msg = err.stderr?.toString?.() || err.message;
      if (attempt < maxAttempts) {
        // Hook scripts run curl in background (&) which may still hold the worktree
        // CWD open briefly after the claude process exits. Retry after a short pause.
        console.warn(`[worktree] Remove attempt ${attempt}/${maxAttempts} failed for ${worktreePath}: ${msg.trim()}`);
        await delay(1500);
      } else {
        console.error(`[worktree] Failed to remove ${worktreePath} after ${maxAttempts} attempts: ${msg.trim()}`);
      }
    }
  }
}

/**
 * Delete a git branch.
 * @param {string} repoDir
 * @param {string} branchName
 */
function deleteBranch(repoDir, branchName) {
  try {
    execFileSync(GIT, ["branch", "-D", branchName], {
      cwd: repoDir,
      stdio: "pipe",
      timeout: 5000,
    });
  } catch (err) {
    console.error(`[worktree] Failed to delete branch ${branchName}: ${err.message}`);
  }
}

/**
 * Get diff stats between two branches.
 * @param {string} repoDir
 * @param {string} baseBranch
 * @param {string} headBranch
 * @returns {{ filesChanged: number, insertions: number, deletions: number, diffStat: string }}
 */
function getBranchDiffStats(repoDir, baseBranch, headBranch) {
  try {
    const stat = execFileSync(GIT, ["diff", "--stat", "--no-color", `${baseBranch}...${headBranch}`], {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const numstat = execFileSync(GIT, ["diff", "--numstat", `${baseBranch}...${headBranch}`], {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    let filesChanged = 0, insertions = 0, deletions = 0;
    for (const line of numstat.split("\n")) {
      if (!line.trim()) continue;
      const [add, del] = line.split("\t");
      filesChanged++;
      insertions += parseInt(add, 10) || 0;
      deletions += parseInt(del, 10) || 0;
    }

    return { filesChanged, insertions, deletions, diffStat: stat };
  } catch {
    return { filesChanged: 0, insertions: 0, deletions: 0, diffStat: "" };
  }
}

/**
 * Check for merge conflicts between a branch and its base using git merge-tree.
 * Returns a conflict description string, or null if clean.
 * @param {string} repoDir
 * @param {string} baseBranch
 * @param {string} headBranch
 * @returns {string | null}
 */
function detectConflicts(repoDir, baseBranch, headBranch) {
  try {
    // git merge-tree --write-tree exits non-zero if there are conflicts
    execFileSync(GIT, ["merge-tree", "--write-tree", baseBranch, headBranch], {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return null; // clean merge
  } catch (err) {
    const output = err.stdout?.toString?.() || err.message;
    // Extract conflicted file names
    const conflicts = [];
    for (const line of output.split("\n")) {
      if (line.startsWith("CONFLICT")) {
        conflicts.push(line);
      }
    }
    return conflicts.length > 0 ? conflicts.join("\n") : "Merge conflicts detected";
  }
}

// Re-export helpers for use by server endpoints
export { deleteBranch, getBranchDiffStats, detectConflicts, getCurrentBranch, removeWorktree };

/**
 * Spawn a new independent Claude Code agent as part of a swarm.
 * Unlike sendPrompt, this does NOT resume an existing session — it launches
 * a fresh `claude` process with its own session.
 *
 * When useWorktree is true, creates a temporary git worktree so the agent
 * works on an isolated copy of the repo. The worktree is cleaned up on exit.
 *
 * @param {{ prompt: string, cwd: string, description: string, permissionMode?: string, maxTurns?: number, model?: string, parentSessionId: string, useWorktree?: boolean }} opts
 * @param {(event: object) => void} onEvent - Called for lifecycle events
 * @returns {Promise<{ id: string, controller: AbortController }>}
 */
export async function spawnSwarmAgent({ prompt, cwd, description, permissionMode, maxTurns, model, parentSessionId, useWorktree }, onEvent) {
  const id = randomUUID().slice(0, 12);

  const controller = new AbortController();

  // If worktree requested, create an isolated copy of the repo with a named branch
  let effectiveCwd = cwd;
  let worktreePath = null;
  let branchName = null;
  let baseBranch = null;
  if (useWorktree) {
    try {
      const wt = createWorktree(cwd, id, description);
      worktreePath = wt.worktreePath;
      branchName = wt.branchName;
      baseBranch = wt.baseBranch;
      effectiveCwd = worktreePath;
      console.log(`[swarm:${id}] Created worktree at ${worktreePath} on branch ${branchName} (base: ${baseBranch})`);
    } catch (err) {
      console.error(`[swarm:${id}] Failed to create worktree: ${err.message}`);
      throw new Error(`Failed to create git worktree: ${err.message}`);
    }
  }

  const args = [
    "--print",
    "--output-format", "stream-json",
    "--max-turns", String(maxTurns ?? 25),
    "--verbose",
  ];

  // Add permission mode
  const validModes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"];
  if (permissionMode && validModes.includes(permissionMode)) {
    args.push("--permission-mode", permissionMode);
    if (permissionMode === "bypassPermissions") {
      args.push("--dangerously-skip-permissions");
    }
  }

  // Add model if specified — validate to prevent flag injection (e.g. "--dangerously-skip-permissions")
  if (model && /^[a-zA-Z0-9._/-]+$/.test(model)) {
    args.push("--model", model);
  }

  args.push("--", prompt);

  const proc = spawn("claude", args, {
    cwd: effectiveCwd,
    signal: controller.signal,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const agent = {
    id,
    controller,
    proc,
    description,
    status: "running",
    startedAt: Date.now(),
    sessionId: parentSessionId,
    worktreePath,
    branchName,
    baseBranch,
    baseCwd: cwd,
  };

  activeSwarmAgents.set(id, agent);

  let buffer = "";

  proc.stdout.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        onEvent({ type: "swarm:chunk", agentId: id, chunk: msg });
      } catch {
        onEvent({ type: "swarm:chunk", agentId: id, chunk: { type: "raw", text: line } });
      }
    }
  });

  proc.stderr.on("data", (data) => {
    console.error(`[swarm:${id}] ${data.toString()}`);
  });

  proc.on("close", async (code) => {
    if (buffer.trim()) {
      try {
        onEvent({ type: "swarm:chunk", agentId: id, chunk: JSON.parse(buffer) });
      } catch {
        onEvent({ type: "swarm:chunk", agentId: id, chunk: { type: "raw", text: buffer.trim() } });
      }
    }
    agent.status = code === 0 ? "completed" : "error";
    activeSwarmAgents.delete(id);

    // For worktree agents: commit any uncommitted changes before removing the checkout.
    // The agent edits files in the working tree but doesn't commit — without this,
    // removeWorktree discards all changes and the branch stays at the base commit.
    if (worktreePath) {
      try {
        const statusOut = execFileSync(GIT, ["status", "--porcelain"], {
          cwd: worktreePath,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 5000,
        }).trim();
        if (!statusOut) {
          console.log(`[swarm:${id}] No changes to commit in worktree`);
        } else {
          console.log(`[swarm:${id}] Staging ${statusOut.split("\n").length} changed file(s)`);
        }
        execFileSync(GIT, ["add", "-A"], { cwd: worktreePath, stdio: "pipe", timeout: 10000 });
        execFileSync(GIT, ["commit", "-m", `agent: ${description || id}`], {
          cwd: worktreePath,
          stdio: "pipe",
          timeout: 10000,
          env: { ...process.env, GIT_AUTHOR_NAME: "Agent", GIT_COMMITTER_NAME: "Agent", GIT_AUTHOR_EMAIL: "agent@dashboard", GIT_COMMITTER_EMAIL: "agent@dashboard" },
        });
        console.log(`[swarm:${id}] Committed agent changes to branch ${branchName}`);
      } catch (err) {
        // "nothing to commit" exits non-zero — that's fine
        const msg = err.stderr?.toString?.().trim() || err.message;
        if (!msg.includes("nothing to commit") && !msg.includes("nothing added to commit")) {
          console.warn(`[swarm:${id}] Auto-commit warning: ${msg}`);
        }
      }
      await removeWorktree(cwd, worktreePath);
    }

    // Gather branch stats for the worktree record (if applicable)
    let worktreeStats = null;
    if (branchName && baseBranch) {
      const stats = getBranchDiffStats(cwd, baseBranch, branchName);
      const conflictInfo = detectConflicts(cwd, baseBranch, branchName);
      worktreeStats = { ...stats, conflictInfo, branchName, baseBranch };
    }

    onEvent({
      type: "swarm:done",
      agentId: id,
      exitCode: code,
      description,
      worktree: worktreeStats,
    });
  });

  proc.on("error", (err) => {
    agent.status = "error";
    activeSwarmAgents.delete(id);
    if (worktreePath) {
      removeWorktree(cwd, worktreePath).catch(() => {});
    }
    // On error, also clean up the branch since no useful work was done
    if (branchName) {
      deleteBranch(cwd, branchName);
    }
    onEvent({ type: "swarm:done", agentId: id, exitCode: null, error: err.message, description });
  });

  return { id, controller };
}

/**
 * Cancel a running swarm agent.
 * @param {string} agentId
 * @returns {boolean}
 */
export function cancelSwarmAgent(agentId) {
  const entry = activeSwarmAgents.get(agentId);
  if (entry) {
    entry.controller.abort();
    entry.status = "cancelled";
    activeSwarmAgents.delete(agentId);
    // Clean up worktree and branch (cancelled = no useful work)
    if (entry.worktreePath) {
      removeWorktree(entry.baseCwd, entry.worktreePath).catch(() => {});
    }
    if (entry.branchName) {
      deleteBranch(entry.baseCwd, entry.branchName);
    }
    return true;
  }
  return false;
}

/**
 * Get all active swarm agents, optionally filtered by parent session.
 * @param {string} [sessionId]
 * @returns {Array<{ id: string, description: string, status: string, startedAt: number, sessionId: string }>}
 */
export function getActiveSwarmAgents(sessionId) {
  const results = [];
  for (const agent of activeSwarmAgents.values()) {
    if (!sessionId || agent.sessionId === sessionId) {
      results.push({
        id: agent.id,
        description: agent.description,
        status: agent.status,
        startedAt: agent.startedAt,
        sessionId: agent.sessionId,
      });
    }
  }
  return results;
}
