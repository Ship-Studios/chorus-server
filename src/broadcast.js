import { getIO } from "./socket.js";

// --- Debounced diff invalidation ---
// Multiple sources fire diff:invalidated for the same underlying change (hook,
// diff-watcher, prompt:done). Coalesce per-session with a 300ms trailing-edge
// debounce so the UI receives at most one signal per burst.
const diffTimers = new Map();

/**
 * Coalesces multiple "diff:invalidated" signals into one per session with a debounce.
 *
 * @param {string} sessionId - The ID of the session to invalidate.
 */
export function debouncedDiffInvalidation(sessionId) {
  if (diffTimers.has(sessionId)) clearTimeout(diffTimers.get(sessionId));
  diffTimers.set(
    sessionId,
    setTimeout(() => {
      diffTimers.delete(sessionId);
      broadcastToSession(sessionId, { type: "diff:invalidated", sessionId });
    }, 300),
  );
}

/**
 * Cancels all pending diff debounce timers.
 * Used during server shutdown to ensure a clean exit.
 */
export function clearDiffTimers() {
  for (const timer of diffTimers.values()) clearTimeout(timer);
  diffTimers.clear();
}

/**
 * Broadcasts a message to all connected clients (global events).
 * Used for events like session:updated, session:deleted, event:new, agent:new.
 *
 * @param {object} message - The message object to broadcast.
 */
export function broadcast(message) {
  const io = getIO();
  if (!io) return;
  try {
    io.emit("message", message);
  } catch (err) {
    console.warn("[ws] broadcast failed:", err.message);
  }
}

/**
 * Broadcasts a message only to clients subscribed to a specific session room.
 * Used for session-specific events like prompt:*, swarm:*, diff:*, worktree:*.
 *
 * @param {string} sessionId - The ID of the session room to broadcast to.
 * @param {object} message - The message object to broadcast.
 */
export function broadcastToSession(sessionId, message) {
  const io = getIO();
  if (!io) return;
  try {
    io.to(`session:${sessionId}`).emit("message", message);
  } catch (err) {
    console.warn("[ws] broadcastToSession failed:", err.message);
  }
}
