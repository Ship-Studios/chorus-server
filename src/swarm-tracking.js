/**
 * swarm-tracking.js — Agent lifecycle tracking and management.
 *
 * Provides in-memory tracking of active spawned agents, cancellation, and
 * concurrency management. Works in conjunction with bridge-backed operations.
 *
 * @module swarm-tracking
 */

import { cancelBridgePrompt } from "./routes/bridge.js";
import { onBroadcastToSession } from "./broadcast.js";

/**
 * Active agents tracked by this adapter.
 * Keyed by agentId -> { id, description, status, startedAt, sessionId }.
 * @type {Map<string, object>}
 */
const activeAgentMap = new Map();

/**
 * Track an agent (called on dispatch).
 * @param {object} agent - { id, description, status, startedAt, sessionId }
 */
export function trackAgent(agent) {
  activeAgentMap.set(agent.id, agent);
}

/**
 * Remove an agent from tracking (called when it completes via bridge event).
 * @param {string} agentId
 */
export function untrackAgent(agentId) {
  activeAgentMap.delete(agentId);
}

/**
 * Cancel an agent by agentId.
 * @param {string} agentId
 * @returns {{ cancelled: boolean }}
 */
export function cancelAgent(agentId) {
  const cancelled = cancelBridgePrompt(agentId);
  if (cancelled) {
    activeAgentMap.delete(agentId);
  }
  return { cancelled };
}

/**
 * Get active agents, optionally filtered by session.
 * @param {string} [sessionId]
 * @returns {Array<object>}
 */
export function getActiveAgents(sessionId) {
  const results = [];
  for (const agent of activeAgentMap.values()) {
    if (!sessionId || agent.sessionId === sessionId) {
      results.push({ ...agent });
    }
  }
  return results;
}

/**
 * Check if there are any active agents.
 * @returns {boolean}
 */
export function hasActiveAgents() {
  return activeAgentMap.size > 0;
}

// ---------------------------------------------------------------------------
// Auto-cleanup via broadcast interceptor
// ---------------------------------------------------------------------------
// When a prompt:done or agent completion event flows through broadcastToSession,
// this interceptor cleans up our local tracking map automatically.
//
// Exported as a named function so unit tests can invoke it directly without
// depending on the broadcast wiring (which may not re-run when the module is
// pre-cached by another test file's import).

export function _broadcastInterceptor(_sessionId, message) {
  if (!message) return;

  if (message.type === "prompt:done" && message.instanceId) {
    activeAgentMap.delete(message.instanceId);
  }
}

onBroadcastToSession(_broadcastInterceptor);
