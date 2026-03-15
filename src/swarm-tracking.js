/**
 * swarm-tracking.js — Swarm agent lifecycle tracking and management.
 *
 * Provides in-memory tracking of active swarm agents, cancellation, and
 * concurrency management. Works in conjunction with bridge-backed swarm operations.
 *
 * @module swarm-tracking
 */

import { cancelBridgePrompt } from "./routes/bridge.js";
import { onBroadcastToSession } from "./broadcast.js";

/**
 * Active swarm agents tracked by this adapter.
 * Keyed by agentId -> { id, description, status, startedAt, sessionId }.
 * @type {Map<string, object>}
 */
const activeSwarmAgentMap = new Map();

/**
 * Track a swarm agent (called by swarm route on dispatch).
 * @param {object} agent - { id, description, status, startedAt, sessionId }
 */
export function trackSwarmAgent(agent) {
  activeSwarmAgentMap.set(agent.id, agent);
}

/**
 * Remove a swarm agent from tracking (called when swarm completes via bridge event).
 * @param {string} agentId
 */
export function untrackSwarmAgent(agentId) {
  activeSwarmAgentMap.delete(agentId);
}

/**
 * Cancel a swarm agent by agentId.
 * Backward-compatible with the old cancelSwarmAgent(agentId) signature.
 * @param {string} agentId
 * @returns {{ cancelled: boolean }}
 */
export function cancelSwarmAgent(agentId) {
  const cancelled = cancelBridgePrompt(agentId);
  if (cancelled) {
    activeSwarmAgentMap.delete(agentId);
  }
  return { cancelled };
}

/**
 * Get active swarm agents, optionally filtered by session.
 * Backward-compatible with the old getActiveSwarmAgents(sessionId) signature.
 * @param {string} [sessionId]
 * @returns {Array<object>}
 */
export function getActiveSwarmAgents(sessionId) {
  const results = [];
  for (const agent of activeSwarmAgentMap.values()) {
    if (!sessionId || agent.sessionId === sessionId) {
      results.push({ ...agent });
    }
  }
  return results;
}

/**
 * Check if there are any active swarm agents.
 * @returns {boolean}
 */
export function hasActiveSwarmAgents() {
  return activeSwarmAgentMap.size > 0;
}

// ---------------------------------------------------------------------------
// Auto-cleanup via broadcast interceptor
// ---------------------------------------------------------------------------
// When bridge.js relays swarm:done through broadcastToSession, this
// interceptor cleans up our local tracking map automatically.

onBroadcastToSession((_sessionId, message) => {
  if (!message) return;

  if (message.type === "swarm:done" && message.agentId) {
    activeSwarmAgentMap.delete(message.agentId);
  }
});
