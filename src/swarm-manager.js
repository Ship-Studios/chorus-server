import { spawn, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
    env: { ...process.env, DASHBOARD_SWARM_AGENT_ID: id },
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

  const parser = createStreamParser((chunk) => {
    onEvent({ type: "swarm:chunk", agentId: id, chunk });
  });

  proc.stdout.on("data", (data) => {
    parser.feed(data);
  });

  proc.stderr.on("data", (data) => {
    console.error(`[swarm:${id}] ${data.toString()}`);
  });

  proc.on("close", async (code) => {
    parser.flush();

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
 * Uses SIGTERM first, then escalates to SIGKILL after a timeout
 * in case Claude Code ignores SIGTERM (a known issue).
 * Sets status to "cancelled" so the close handler skips cleanup
 * (this function handles cleanup directly to avoid a race).
 * @param {string} agentId
 * @returns {boolean}
 */
export function cancelSwarmAgent(agentId) {
  const entry = activeSwarmAgents.get(agentId);
  if (entry) {
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
