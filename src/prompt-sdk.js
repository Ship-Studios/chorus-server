/**
 * prompt-sdk.js — Agent SDK-based prompt submission.
 *
 * Replaces the CLI subprocess approach (prompt.js) with the Agent SDK's
 * `query()` function. Tool calls are routed through the WebSocket bridge
 * to the local MCP daemon running on the user's machine.
 *
 * Key differences from the CLI approach:
 *   - No process spawning — runs in-process via the Agent SDK
 *   - Tool execution routed through WebSocket bridge (not handled by CLI)
 *   - Conversation resume via SDK's built-in `resume` option
 *   - Cancellation via AbortController (not SIGTERM/SIGKILL)
 *   - Streaming via AsyncGenerator<SDKMessage> (not stdout parsing)
 *
 * @module prompt-sdk
 */

import { query, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { createToolDefinitions } from "./agent-tools.js";
import { executeRemoteTool, isBridgeConnected } from "./routes/bridge.js";

// ---------------------------------------------------------------------------
// Active prompt tracking — same concurrency model as the CLI version
// ---------------------------------------------------------------------------

/** @type {Map<string, { abortController: AbortController, done: boolean, cancelled?: boolean }>} */
const activePrompts = new Map();

// ---------------------------------------------------------------------------
// MCP Server for bridge-routed tools
// ---------------------------------------------------------------------------

/** @type {ReturnType<typeof createSdkMcpServer> | null} */
let mcpServer = null;

/**
 * Get or create the MCP server with tool definitions routed through the bridge.
 * Lazily initialized so we don't create it at import time (build-safe).
 *
 * @param {string} projectDir - Project directory for routing tool calls
 * @returns {ReturnType<typeof createSdkMcpServer>}
 */
function getMcpServer(projectDir) {
  // Create a fresh MCP server per call so tools route to the correct projectDir.
  // The Agent SDK tools receive a projectDir closure for routing.
  const toolDefs = createToolDefinitions((bridgeToolName, params) => {
    // Inject project dir as cwd for bash/git tools that need it
    if (["bash_exec", "git_diff", "git_status", "git_log"].includes(bridgeToolName) && !params.cwd) {
      params.cwd = projectDir;
    }
    return executeRemoteTool(projectDir, bridgeToolName, params);
  });

  return createSdkMcpServer({
    name: "chorus-bridge",
    version: "1.0.0",
    tools: toolDefs,
  });
}

// ---------------------------------------------------------------------------
// Core: sendPrompt
// ---------------------------------------------------------------------------

/**
 * Send a prompt via the Agent SDK and stream responses.
 *
 * @param {string} dashboardSessionId - Dashboard session ID (for tracking)
 * @param {{ prompt: string, cwd: string, claudeSessionId: string, permissionMode?: string, model?: string }} opts
 * @param {(chunk: object) => void} onChunk - Called for each SDKMessage event
 * @param {(result: { code: number | null, cancelled?: boolean, error?: string }) => void} onDone - Called when query completes
 * @returns {AbortController}
 */
export function sendPrompt(dashboardSessionId, { prompt, cwd, claudeSessionId, permissionMode, model }, onChunk, onDone) {
  // Concurrency check — same as CLI version
  const existing = activePrompts.get(dashboardSessionId);
  if (existing && !existing.done) {
    throw new Error("A prompt is already running for this session");
  }

  const abortController = new AbortController();
  activePrompts.set(dashboardSessionId, { abortController, done: false });

  // Check bridge connectivity
  if (!isBridgeConnected(cwd)) {
    console.warn(`[prompt-sdk:${dashboardSessionId}] No local agent connected for ${cwd} — tools will be unavailable`);
  }

  // Build SDK options
  const mcpServerConfig = getMcpServer(cwd);

  /** @type {import("@anthropic-ai/claude-agent-sdk").Options} */
  const options = {
    abortController,
    cwd,
    model: model || undefined,
    mcpServers: [mcpServerConfig],
    allowedTools: ["Read", "Write", "Edit", "Bash", "Glob", "Grep", "ListDir", "GitDiff", "GitStatus", "GitLog"],
    includePartialMessages: true,
    persistSession: false, // We manage conversation state ourselves
  };

  // Resume existing conversation if we have a CLI session ID
  if (claudeSessionId) {
    options.resume = claudeSessionId;
  }

  // Permission mode mapping
  const validModes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"];
  if (permissionMode && validModes.includes(permissionMode)) {
    if (permissionMode === "bypassPermissions") {
      options.permissionMode = "bypassPermissions";
    } else {
      options.permissionMode = permissionMode;
    }
  }

  // Run the query asynchronously
  runQuery(dashboardSessionId, prompt, options, onChunk, onDone);

  return abortController;
}

/**
 * Internal: Run the Agent SDK query and stream events.
 */
async function runQuery(dashboardSessionId, prompt, options, onChunk, onDone) {
  let didFallback = false;

  try {
    const q = query({ prompt, options });

    for await (const message of q) {
      // Broadcast each SDK message to WebSocket clients
      onChunk(message);
    }

    // Query completed successfully
    finishPrompt(dashboardSessionId, onDone, { code: 0, freshSession: didFallback });
  } catch (err) {
    const entry = activePrompts.get(dashboardSessionId);

    // Check if this was a cancellation
    if (entry?.cancelled || err.name === "AbortError") {
      finishPrompt(dashboardSessionId, onDone, { code: null, cancelled: true });
      return;
    }

    // Check if resume failed (conversation not found) — retry fresh
    if (!didFallback && options.resume && /no conversation found|session.*not found|expired/i.test(err.message)) {
      didFallback = true;
      console.log(`[prompt-sdk:${dashboardSessionId}] Resume failed, retrying as fresh prompt`);
      onChunk({ type: "prompt:context-lost", sessionId: dashboardSessionId, reason: "Session expired — starting fresh conversation" });
      onChunk({ type: "system", text: "Session expired — starting fresh prompt in the same project directory." });

      // Retry without resume
      const freshOptions = { ...options };
      delete freshOptions.resume;
      return runQuery(dashboardSessionId, prompt, freshOptions, onChunk, onDone);
    }

    // Genuine error
    console.error(`[prompt-sdk:${dashboardSessionId}] Error:`, err.message);
    finishPrompt(dashboardSessionId, onDone, { code: 1, error: err.message });
  }
}

/**
 * Clean up after a prompt completes.
 */
function finishPrompt(dashboardSessionId, onDone, result) {
  const entry = activePrompts.get(dashboardSessionId);
  if (entry) entry.done = true;
  onDone(result);

  // Grace period before removing from map (same as CLI version)
  setTimeout(() => {
    if (activePrompts.get(dashboardSessionId) === entry) {
      activePrompts.delete(dashboardSessionId);
    }
  }, 5000);
}

// ---------------------------------------------------------------------------
// Control functions — same interface as the CLI version
// ---------------------------------------------------------------------------

/**
 * Cancel a running prompt.
 * @param {string} dashboardSessionId
 * @returns {boolean} Whether a prompt was cancelled
 */
export function cancelPrompt(dashboardSessionId) {
  const entry = activePrompts.get(dashboardSessionId);
  if (entry && !entry.done) {
    entry.cancelled = true;
    entry.done = true;
    entry.abortController.abort();
    return true;
  }
  return false;
}

/**
 * Check if a prompt is currently active.
 * @param {string} dashboardSessionId
 * @returns {boolean}
 */
export function isPromptActive(dashboardSessionId) {
  const entry = activePrompts.get(dashboardSessionId);
  return entry ? !entry.done : false;
}

/**
 * Get the Claude session ID for the active prompt.
 * With the Agent SDK, this returns the dashboard session ID itself
 * (the SDK manages its own session internally).
 * @param {string} dashboardSessionId
 * @returns {string | null}
 */
export function getPromptSessionId(dashboardSessionId) {
  return activePrompts.has(dashboardSessionId) ? dashboardSessionId : null;
}

// Re-export git-worktree helpers for backward compatibility
export { deleteBranch, getBranchDiffStats, detectConflicts, removeWorktree, getCurrentBranch } from "./git-worktree.js";

// Re-export swarm functions for backward compatibility
export { spawnSwarmAgent, cancelSwarmAgent, getActiveSwarmAgents, hasActiveSwarmAgents } from "./swarm-manager.js";
