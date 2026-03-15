/**
 * prompt-tracking.js — Session-to-requestId mapping for prompt lifecycle.
 *
 * Provides tracking and cancellation of active prompts by session ID.
 * Works in conjunction with bridge-backed prompt operations.
 *
 * @module prompt-tracking
 */

import { cancelBridgePrompt, isBridgePromptActive } from "./routes/bridge.js";
import { onBroadcastToSession } from "./broadcast.js";

/**
 * Session-to-requestId mapping for prompt cancel-by-session.
 * Populated by routes that call dispatchPromptToBridge.
 * @type {Map<string, string>}
 */
const sessionToRequestId = new Map();

/**
 * Track a sessionId -> requestId mapping (called by prompt route on dispatch).
 * @param {string} sessionId
 * @param {string} requestId
 */
export function trackPromptRequest(sessionId, requestId) {
  sessionToRequestId.set(sessionId, requestId);
}

/**
 * Remove a sessionId -> requestId mapping (called when prompt completes).
 * @param {string} sessionId
 */
export function untrackPromptRequest(sessionId) {
  sessionToRequestId.delete(sessionId);
}

/**
 * Check if a prompt is active for a session.
 * Backward-compatible with the old isPromptActive(sessionId) signature.
 * @param {string} sessionId
 * @returns {boolean}
 */
export function isPromptActive(sessionId) {
  return isBridgePromptActive(sessionId);
}

/**
 * Cancel an active prompt by session ID.
 * Backward-compatible with the old cancelPrompt(sessionId) signature.
 * @param {string} sessionId
 * @returns {boolean}
 */
export function cancelPrompt(sessionId) {
  const requestId = sessionToRequestId.get(sessionId);
  if (!requestId) return false;
  sessionToRequestId.delete(sessionId);
  return cancelBridgePrompt(requestId);
}

// ---------------------------------------------------------------------------
// Auto-cleanup via broadcast interceptor
// ---------------------------------------------------------------------------
// When bridge.js relays prompt:done through broadcastToSession, this
// interceptor cleans up our local tracking map automatically.

onBroadcastToSession((_sessionId, message) => {
  if (!message) return;

  if (message.type === "prompt:done" && message.sessionId) {
    sessionToRequestId.delete(message.sessionId);
  }
});
