import { getIO } from "./socket.js";

// --- Debounced diff invalidation ---
// Multiple sources fire diff:invalidated for the same underlying change (hook,
// git-watcher, prompt:done). Coalesce per-session with a 300ms trailing-edge
// debounce so the UI receives at most one signal per burst.
const diffTimers = new Map();

export function debouncedDiffInvalidation(sessionId) {
  if (diffTimers.has(sessionId)) return; // already scheduled
  diffTimers.set(
    sessionId,
    setTimeout(() => {
      diffTimers.delete(sessionId);
      broadcastToSession(sessionId, { type: "diff:invalidated", sessionId });
    }, 300),
  );
}

/** Cancel all pending diff debounce timers (used during shutdown). */
export function clearDiffTimers() {
  for (const timer of diffTimers.values()) clearTimeout(timer);
  diffTimers.clear();
}

/**
 * Broadcast a message to ALL connected clients (global events).
 * Used for: session:updated, session:deleted, event:new, agent:new.
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
 * Broadcast a message only to clients subscribed to a specific session room.
 * Used for: prompt:*, swarm:*, diff:*, worktree:*.
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
