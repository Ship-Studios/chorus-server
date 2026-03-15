/**
 * swarm-manager-sdk.js — Agent SDK-based swarm agent spawning.
 *
 * Replaces the CLI subprocess approach (swarm-manager.js) with the Agent SDK's
 * `query()` function. Each swarm agent is an async task, not a process.
 *
 * Key differences from the CLI approach:
 *   - No process spawning — runs in-process via the Agent SDK
 *   - Tool execution routed through WebSocket bridge (not handled by CLI)
 *   - Cancellation via AbortController (not SIGTERM/SIGKILL)
 *   - Streaming via AsyncGenerator<SDKMessage> (not stdout parsing)
 *   - Images passed as multimodal content blocks (no temp files)
 *   - One MCP server instance per agent (fresh per spawn, scoped to cwd)
 *
 * @module swarm-manager-sdk
 */

import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { createToolDefinitions } from "./agent-tools.js";
import { executeRemoteTool, isBridgeConnected } from "./routes/bridge.js";
import {
  autoCommitWorktree,
  createWorktree,
  removeWorktree,
  deleteBranchAsync,
  getBranchDiffStatsAsync,
  detectConflictsAsync,
} from "./git-worktree.js";

// ---------------------------------------------------------------------------
// Active agent tracking
// ---------------------------------------------------------------------------

/**
 * @type {Map<string, {
 *   id: string,
 *   abortController: AbortController,
 *   status: string,
 *   description: string,
 *   startedAt: number,
 *   sessionId: string,
 *   baseCwd: string,
 *   worktreePath?: string,
 *   branchName?: string,
 *   baseBranch?: string,
 * }>}
 */
const activeAgents = new Map();

const MAX_SWARM_AGENTS = Number(process.env.MAX_SWARM_AGENTS) || 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an MCP server whose tools are routed through the WebSocket bridge.
 *
 * @param {string} cwd - Working directory for this agent (used to scope bridge routing)
 * @returns {ReturnType<typeof createSdkMcpServer>}
 */
function createAgentMcpServer(cwd) {
  const toolDefs = createToolDefinitions((bridgeToolName, params) => {
    // Inject cwd for tools that need it
    if (["bash_exec", "git_diff", "git_status", "git_log"].includes(bridgeToolName) && !params.cwd) {
      params.cwd = cwd;
    }
    return executeRemoteTool(cwd, bridgeToolName, params);
  });

  return createSdkMcpServer({
    name: "chorus-bridge",
    version: "1.0.0",
    tools: toolDefs,
  });
}

/**
 * Clean up worktree + branch after a cancelled or failed agent.
 * Does not commit — cancelled work is discarded.
 *
 * @param {string} baseCwd
 * @param {string | null} worktreePath
 * @param {string | null} branchName
 */
async function cleanupSwarmWorktree(baseCwd, worktreePath, branchName) {
  if (worktreePath) {
    await removeWorktree(baseCwd, worktreePath);
  }
  if (branchName) {
    await deleteBranchAsync(baseCwd, branchName);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawn a new independent swarm agent via the Agent SDK.
 *
 * Unlike sendPrompt, this does NOT resume an existing session — it launches
 * a fresh query with its own MCP server instance.
 *
 * When useWorktree is true, creates a temporary git worktree so the agent
 * works on an isolated copy of the repo. The worktree is cleaned up on exit.
 *
 * @param {{
 *   prompt: string,
 *   cwd: string,
 *   description: string,
 *   permissionMode?: string,
 *   model?: string,
 *   parentSessionId: string,
 *   useWorktree?: boolean,
 *   maxTurns?: number,
 *   image?: { data: string, mimeType: string },
 * }} opts
 * @param {(event: object) => void} onEvent - Called for lifecycle events
 * @returns {{ agentId: string }}
 */
export function spawnSwarmAgent(
  { prompt, cwd, description, permissionMode, model, parentSessionId, useWorktree, maxTurns, image },
  onEvent
) {
  if (activeAgents.size >= MAX_SWARM_AGENTS) {
    throw new Error(`Maximum concurrent swarm agents (${MAX_SWARM_AGENTS}) reached`);
  }

  const agentId = randomUUID().slice(0, 12);
  const abortController = new AbortController();

  // Reserve slot immediately to close the concurrency gap.
  activeAgents.set(agentId, {
    id: agentId,
    abortController,
    status: "pending",
    description,
    startedAt: Date.now(),
    sessionId: parentSessionId,
    baseCwd: cwd,
  });

  // Fire and forget — errors are caught inside runSwarmAgent
  runSwarmAgent(
    agentId,
    { prompt, cwd, description, permissionMode, model, parentSessionId, useWorktree, maxTurns, image },
    onEvent
  ).catch((err) => {
    console.error(`[swarm-sdk:${agentId}] Unhandled runSwarmAgent error:`, err);
  });

  return { agentId };
}

/**
 * Internal: Run the Agent SDK query for a swarm agent.
 * Handles worktree setup/teardown, streaming, and completion reporting.
 *
 * @param {string} agentId
 * @param {{
 *   prompt: string,
 *   cwd: string,
 *   description: string,
 *   permissionMode?: string,
 *   model?: string,
 *   parentSessionId: string,
 *   useWorktree?: boolean,
 *   maxTurns?: number,
 *   image?: { data: string, mimeType: string },
 * }} opts
 * @param {(event: object) => void} onEvent
 */
async function runSwarmAgent(
  agentId,
  { prompt, cwd, description, permissionMode, model, parentSessionId, useWorktree, maxTurns, image },
  onEvent
) {
  const agent = activeAgents.get(agentId);

  // ------------------------------------------------------------------
  // 1. Worktree setup (optional)
  // ------------------------------------------------------------------
  let effectiveCwd = cwd;
  let worktreePath = null;
  let branchName = null;
  let baseBranch = null;

  if (useWorktree) {
    try {
      const wt = await createWorktree(cwd, agentId, description);
      worktreePath = wt.worktreePath;
      branchName = wt.branchName;
      baseBranch = wt.baseBranch;
      effectiveCwd = worktreePath;
      console.log(`[swarm-sdk:${agentId}] Created worktree at ${worktreePath} on branch ${branchName} (base: ${baseBranch})`);
    } catch (err) {
      activeAgents.delete(agentId);
      console.error(`[swarm-sdk:${agentId}] Failed to create worktree: ${err.message}`);
      onEvent({
        type: "swarm:done",
        agentId,
        exitCode: 1,
        error: `Failed to create git worktree: ${err.message}`,
        description,
      });
      return;
    }
  }

  // Store worktree info on the agent record
  Object.assign(agent, { worktreePath, branchName, baseBranch, status: "running" });

  // ------------------------------------------------------------------
  // 2. Check bridge connectivity
  // ------------------------------------------------------------------
  if (!isBridgeConnected(effectiveCwd)) {
    console.warn(`[swarm-sdk:${agentId}] No local agent connected for ${effectiveCwd} — tools will be unavailable`);
  }

  // ------------------------------------------------------------------
  // 3. Emit swarm:spawned
  // ------------------------------------------------------------------
  const worktreePayload = worktreePath
    ? { path: worktreePath, branchName, baseBranch }
    : undefined;

  onEvent({
    type: "swarm:spawned",
    agentId,
    parentSessionId,
    description,
    startedAt: agent.startedAt,
    worktree: worktreePayload,
  });

  // ------------------------------------------------------------------
  // 4. Build prompt content (with optional image)
  // ------------------------------------------------------------------
  let promptContent;
  if (image?.data) {
    const userContent = [];
    userContent.push({
      type: "image",
      source: {
        type: "base64",
        media_type: image.mimeType,
        data: image.data,
      },
    });
    userContent.push({ type: "text", text: prompt });
    promptContent = userContent;
  } else {
    promptContent = prompt;
  }

  // ------------------------------------------------------------------
  // 5. Build Agent SDK options
  // ------------------------------------------------------------------
  const mcpServerConfig = createAgentMcpServer(effectiveCwd);

  /** @type {import("@anthropic-ai/claude-agent-sdk").Options} */
  const options = {
    abortController: agent.abortController,
    cwd: effectiveCwd,
    mcpServers: [mcpServerConfig],
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "ListDir", "GitDiff", "GitStatus", "GitLog"],
    includePartialMessages: true,
    persistSession: false,
  };

  // Model — validate to prevent flag injection
  if (model && /^[a-zA-Z0-9._/-]+$/.test(model)) {
    options.model = model;
  }

  // Max turns
  if (maxTurns && Number.isInteger(maxTurns) && maxTurns > 0) {
    options.maxTurns = maxTurns;
  }

  // Permission mode
  const validModes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"];
  if (permissionMode && validModes.includes(permissionMode)) {
    options.permissionMode = permissionMode;
  }

  // ------------------------------------------------------------------
  // 6. Run query and stream events
  // ------------------------------------------------------------------
  let exitCode = 0;
  let exitError = null;

  try {
    const q = query({ prompt: promptContent, options });

    for await (const message of q) {
      // Check if cancelled before forwarding next chunk
      const current = activeAgents.get(agentId);
      if (current?.status === "cancelled") break;

      onEvent({ type: "swarm:chunk", agentId, chunk: message });
    }
  } catch (err) {
    const current = activeAgents.get(agentId);
    if (current?.status === "cancelled" || err.name === "AbortError") {
      // Cancellation path — handled below
      exitCode = null;
    } else {
      console.error(`[swarm-sdk:${agentId}] Query error:`, err.message);
      exitCode = 1;
      exitError = err.message;
    }
  }

  // ------------------------------------------------------------------
  // 7. Check if cancelled mid-run
  // ------------------------------------------------------------------
  const finalAgent = activeAgents.get(agentId);
  if (finalAgent?.status === "cancelled") {
    // cancelSwarmAgent() already deleted from map and will clean up worktree.
    // Just emit done with cancelled flag.
    onEvent({ type: "swarm:done", agentId, exitCode: null, cancelled: true, description });
    return;
  }

  // ------------------------------------------------------------------
  // 8. Update status and remove from active map
  // ------------------------------------------------------------------
  if (finalAgent) {
    finalAgent.status = exitError ? "error" : "completed";
  }
  activeAgents.delete(agentId);

  // ------------------------------------------------------------------
  // 9. Worktree teardown: auto-commit + remove checkout
  // ------------------------------------------------------------------
  if (worktreePath) {
    try {
      await autoCommitWorktree(worktreePath, description, agentId, branchName);
      await removeWorktree(cwd, worktreePath);
    } catch (err) {
      console.error(`[swarm-sdk:${agentId}] Worktree teardown error:`, err.message);
    }
  }

  // ------------------------------------------------------------------
  // 10. Gather branch diff stats (for Reviews tab)
  // ------------------------------------------------------------------
  let worktreeStats = null;
  if (branchName && baseBranch) {
    try {
      const [stats, conflictInfo] = await Promise.all([
        getBranchDiffStatsAsync(cwd, baseBranch, branchName),
        detectConflictsAsync(cwd, baseBranch, branchName),
      ]);
      worktreeStats = { ...stats, conflictInfo, branchName, baseBranch };
    } catch (err) {
      console.error(`[swarm-sdk:${agentId}] Failed to gather branch stats:`, err.message);
    }
  }

  // ------------------------------------------------------------------
  // 11. Emit swarm:done
  // ------------------------------------------------------------------
  onEvent({
    type: "swarm:done",
    agentId,
    exitCode,
    description,
    ...(exitError ? { error: exitError } : {}),
    ...(worktreeStats ? { worktree: worktreeStats } : {}),
  });
}

/**
 * Cancel a running swarm agent.
 * Aborts the Agent SDK query cooperatively via AbortController.
 * Cleans up any reserved worktree immediately (cancelled = no useful work).
 *
 * @param {string} agentId
 * @returns {{ cancelled: boolean, sessionId: string | null }}
 */
export function cancelSwarmAgent(agentId) {
  const entry = activeAgents.get(agentId);
  if (entry) {
    const sessionId = entry.sessionId;
    entry.status = "cancelled";
    entry.abortController.abort();
    activeAgents.delete(agentId);
    // Clean up worktree immediately — cancelled work is discarded
    cleanupSwarmWorktree(entry.baseCwd, entry.worktreePath, entry.branchName).catch(() => {});
    return { cancelled: true, sessionId };
  }
  return { cancelled: false, sessionId: null };
}

/**
 * Get all active swarm agents, optionally filtered by parent session ID.
 *
 * @param {string} [sessionId]
 * @returns {Array<{ id: string, description: string, status: string, startedAt: number, sessionId: string }>}
 */
export function getActiveSwarmAgents(sessionId) {
  const results = [];
  for (const agent of activeAgents.values()) {
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
 * @param {string} [sessionId]
 * @returns {boolean}
 */
export function hasActiveSwarmAgents(sessionId) {
  for (const agent of activeAgents.values()) {
    if (!sessionId || agent.sessionId === sessionId) {
      return true;
    }
  }
  return false;
}
