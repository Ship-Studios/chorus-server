/**
 * prompt-adapter.js — Unified re-export module for backward compatibility.
 *
 * This module maintains backward compatibility by re-exporting all symbols
 * from the decomposed modules. Consumers can continue importing from this file
 * without changes.
 *
 * Decomposed modules:
 * - prompt-tracking.js — Instance-to-session mapping for prompt lifecycle
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

// Re-export bridge relay functions
export {
  dispatchPromptToBridge,
  cancelBridgePrompt,
  isBridgePromptActive,
  isBridgeConnected,
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
 * @deprecated No longer applicable — use cancelPrompt(sessionId)
 */
export function getPromptSessionId() {
  return null;
}
