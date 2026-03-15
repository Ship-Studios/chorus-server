/**
 * prompt-adapter.js — Unified re-export module for backward compatibility.
 *
 * This module maintains backward compatibility by re-exporting all symbols
 * from the decomposed modules. Consumers can continue importing from this file
 * without changes.
 *
 * Decomposed modules:
 * - prompt-tracking.js — Session-to-request mapping for prompt lifecycle
 * - swarm-tracking.js — Swarm agent lifecycle tracking and management
 * - bridge-exports.js — Direct bridge relay function re-exports
 * - git-operations.js — Git worktree operation re-exports
 *
 * @module prompt-adapter
 */

// Re-export prompt tracking functions
export {
  trackPromptRequest,
  untrackPromptRequest,
  isPromptActive,
  cancelPrompt,
} from "./prompt-tracking.js";

// Re-export swarm tracking functions
export {
  trackSwarmAgent,
  untrackSwarmAgent,
  cancelSwarmAgent,
  getActiveSwarmAgents,
  hasActiveSwarmAgents,
} from "./swarm-tracking.js";

// Re-export bridge relay functions
export {
  dispatchPromptToBridge,
  cancelBridgePrompt,
  isBridgePromptActive,
  isBridgeConnected,
  dispatchSwarmToBridge,
  cancelBridgeSwarm,
} from "./bridge-exports.js";

// Re-export git worktree operations
export {
  deleteBranch,
  getBranchDiffStats,
  detectConflicts,
  removeWorktree,
  getCurrentBranch,
} from "./git-operations.js";

// ---------------------------------------------------------------------------
// Deprecated stubs — kept for backward compatibility at import time
// ---------------------------------------------------------------------------

/**
 * @deprecated Use dispatchPromptToBridge instead
 */
export function sendPrompt() {
  throw new Error("sendPrompt() is deprecated — use dispatchPromptToBridge() via the bridge relay");
}

/**
 * @deprecated Use dispatchSwarmToBridge instead
 */
export function spawnSwarmAgent() {
  throw new Error("spawnSwarmAgent() is deprecated — use dispatchSwarmToBridge() via the bridge relay");
}

/**
 * @deprecated Use cancelPrompt(sessionId) which delegates to cancelBridgePrompt
 */
export function getPromptSessionId() {
  return null;
}

// Note: Auto-cleanup via broadcast interceptors is now handled within
// prompt-tracking.js and swarm-tracking.js modules.
