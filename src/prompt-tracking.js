/**
 * prompt-tracking.js — Instance-to-session mapping for prompt lifecycle.
 *
 * Provides tracking and cancellation of active prompts by session ID or
 * instance ID. Works in conjunction with bridge-backed prompt operations.
 *
 * @module prompt-tracking
 */

import { cancelBridgePrompt, isBridgePromptActive } from "./routes/bridge.js";
import { onBroadcastToSession } from "./broadcast.js";

/**
 * Instance-to-session mapping for prompt tracking and cancel-by-session.
 * Populated by routes that call dispatchPromptToBridge.
 * @type {Map<string, string>}
 */
const instanceToSession = new Map();

/**
 * Track an instanceId -> sessionId mapping (called by prompt route on dispatch).
 * @param {string} instanceId
 * @param {string} sessionId
 */
export function trackPromptRequest(instanceId, sessionId) {
  instanceToSession.set(instanceId, sessionId);
}

/**
 * Remove an instanceId -> sessionId mapping (called when prompt completes).
 * @param {string} instanceId
 */
export function untrackPromptRequest(instanceId) {
  instanceToSession.delete(instanceId);
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
 * Finds the instanceId for the given session and cancels via bridge.
 * @param {string} sessionId
 * @returns {boolean}
 */
export function cancelPrompt(sessionId) {
  // Find instanceId for this session
  for (const [instanceId, sid] of instanceToSession) {
    if (sid === sessionId) {
      instanceToSession.delete(instanceId);
      return cancelBridgePrompt(instanceId);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Auto-cleanup via broadcast interceptor
// ---------------------------------------------------------------------------
// When bridge.js relays prompt:done through broadcastToSession, this
// interceptor cleans up our local tracking map automatically.

onBroadcastToSession((_sessionId, message) => {
  if (!message) return;

  if (message.type === "prompt:done" && message.instanceId) {
    instanceToSession.delete(message.instanceId);
  }
});
