import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFile, unlink } from "node:fs/promises";
import { GIT } from "./git.js";
import { createStreamParser } from "./stream-parser.js";
import {
  createWorktree,
  removeWorktree,
  deleteBranch,
  getBranchDiffStats,
  detectConflicts,
} from "./git-worktree.js";

/** @type {Map<string, { id: string, controller: AbortController, proc: import("child_process").ChildProcess, description: string, status: string, startedAt: number, sessionId: string, worktreePath?: string, branchName?: string, baseBranch?: string, baseCwd: string }>} */
const activeSwarmAgents = new Map();

const MAX_SWARM_AGENTS = parseInt(process.env.MAX_SWARM_AGENTS || "10", 10);

/**
 * Spawn a new independent Claude Code agent as part of a swarm.
 * Unlike sendPrompt, this does NOT resume an existing session — it launches
 * a fresh `claude` process with its own session.
 *
 * When useWorktree is true, creates a temporary git worktree so the agent
 * works on an isolated copy of the repo. The worktree is cleaned up on exit.
 *
 * @param {{ prompt: string, cwd: string, description: string, permissionMode?: string, model?: string, parentSessionId: string, useWorktree?: boolean, image?: { data: string, mimeType: string } }} opts
 * @param {(event: object) => void} onEvent - Called for lifecycle events
 * @returns {Promise<{ id: string, controller: AbortController }>}
 */
export async function spawnSwarmAgent({ prompt, cwd, description, permissionMode, model, parentSessionId, useWorktree, image }, onEvent) {
  if (activeSwarmAgents.size >= MAX_SWARM_AGENTS) {
    throw new Error(`Maximum concurrent swarm agents (${MAX_SWARM_AGENTS}) reached`);
  }

  const id = randomUUID().slice(0, 12);
  const controller = new AbortController();

  // Reserve a slot immediately after the size check to close the concurrency gap.
  // The placeholder is replaced below once we have the full agent object.
  // If worktree creation or process spawn fails, we clean up the reservation.
  activeSwarmAgents.set(id, { id, status: "pending", controller, description, startedAt: Date.now(), sessionId: parentSessionId, baseCwd: cwd });

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
      activeSwarmAgents.delete(id);
      console.error(`[swarm:${id}] Failed to create worktree: ${err.message}`);
      throw new Error(`Failed to create git worktree: ${err.message}`);
    }
  }

  const args = [
    "--print",
    "--output-format", "stream-json",
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

  // If an image is attached, save as temp file and prepend a read instruction
  let finalPrompt = prompt;
  let imagePath = null;
  if (image && image.data && image.mimeType) {
    try {
      const rawExt = image.mimeType.split("/")[1] || "png";
      const allowedExts = ["png", "jpg", "jpeg", "gif", "webp"];
      const ext = allowedExts.includes(rawExt) ? rawExt : "png";
      const filename = `.dashboard-screenshot-${randomUUID().slice(0, 8)}.${ext}`;
      imagePath = join(effectiveCwd, filename);
      await writeFile(imagePath, Buffer.from(image.data, "base64"));
      finalPrompt = `[Screenshot attached: ${filename}]\n\nPlease read and analyze the screenshot at "${imagePath}" before responding.\n\n${prompt}`;
      console.log(`[swarm:${id}] Saved screenshot to ${imagePath}`);
    } catch (err) {
      console.error(`[swarm:${id}] Failed to save screenshot:`, err);
      // Continue without the image rather than failing the spawn
    }
  }

  args.push("--", finalPrompt);

  const proc = spawn("claude", args, {
    cwd: effectiveCwd,
    signal: controller.signal,
    env: { ...process.env, DASHBOARD_SWARM_AGENT_ID: id },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Update the reserved slot with the full agent details now that we have the process.
  const agent = activeSwarmAgents.get(id);
  Object.assign(agent, {
    proc,
    status: "running",
    worktreePath,
    branchName,
    baseBranch,
  });

  const parser = createStreamParser((chunk) => {
    onEvent({ type: "swarm:chunk", agentId: id, chunk });
  });

  proc.stdout.on("data", (data) => {
    parser.feed(data);
  });

  proc.stderr.on("data", (data) => {
    const text = data.toString().trim();
    if (text) {
      console.error(`[swarm:${id}] stderr:`, text);
      onEvent({ type: "swarm:chunk", agentId: id, chunk: { type: "stderr", text } });
    }
  });

  proc.on("close", (code) => {
    (async () => {
      parser.flush();

      // Clean up temp screenshot regardless of exit path
      if (imagePath) {
        unlink(imagePath).catch(() => {});
      }

      // If cancelSwarmAgent() already ran, it handled cleanup — just emit done.
      if (agent.status === "cancelled") {
        onEvent({ type: "swarm:done", agentId: id, exitCode: code, cancelled: true, description });
        return;
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
    })().catch(err => {
      console.error("[swarm] close handler error:", err);
      onEvent({ type: "swarm:done", agentId: id, exitCode: code, error: err.message, description });
    });
  });

  proc.on("error", (err) => {
    agent.status = "error";
    activeSwarmAgents.delete(id);
    if (imagePath) {
      unlink(imagePath).catch(() => {});
    }
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
 * Uses SIGTERM first, then escalates to SIGKILL after a timeout
 * in case Claude Code ignores SIGTERM (a known issue).
 * Sets status to "cancelled" so the close handler skips cleanup
 * (this function handles cleanup directly to avoid a race).
 * @param {string} agentId
 * @returns {{ cancelled: boolean, sessionId: string | null }}
 */
export function cancelSwarmAgent(agentId) {
  const entry = activeSwarmAgents.get(agentId);
  if (entry) {
    const sessionId = entry.sessionId;
    entry.status = "cancelled"; // Signal to close handler to skip cleanup
    entry.controller.abort(); // sends SIGTERM
    // Escalate to SIGKILL if process doesn't exit within 3s
    const pid = entry.proc?.pid;
    if (pid) {
      const killTimer = setTimeout(() => {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }, 3000);
      entry.proc.once("close", () => clearTimeout(killTimer));
    }
    activeSwarmAgents.delete(agentId);
    // Clean up worktree and branch (cancelled = no useful work)
    if (entry.worktreePath) {
      removeWorktree(entry.baseCwd, entry.worktreePath).catch(() => {});
    }
    if (entry.branchName) {
      deleteBranch(entry.baseCwd, entry.branchName);
    }
    return { cancelled: true, sessionId };
  }
  return { cancelled: false, sessionId: null };
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

/**
 * Check if there are any active swarm agents, optionally filtered by parent session.
 *
 * @param {string} [sessionId] - The session ID to filter by
 * @returns {boolean}
 */
export function hasActiveSwarmAgents(sessionId) {
  for (const agent of activeSwarmAgents.values()) {
    if (!sessionId || agent.sessionId === sessionId) {
      return true;
    }
  }
  return false;
}
