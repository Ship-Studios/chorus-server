import { getIO } from "./socket.js";
import { getSession } from "./db.js";
import { invalidateDiffCache } from "./diff-cache.js";

// --- Debounced diff invalidation ---
// Multiple sources fire diff:invalidated for the same underlying change (hook,
// diff-watcher, prompt:done). Coalesce per-session with a 300ms trailing-edge
// debounce so the UI receives at most one signal per burst.
const diffTimers = new Map();

function invalidateSessionDiffCache(sessionId) {
  const session = sessionId ? getSession.get({ $id: sessionId }) : null;
  const dir = session ? (session.worktree_dir || session.project_dir) : null;
  invalidateDiffCache(dir || undefined);
}

/**
 * Coalesces multiple "diff:invalidated" signals into one per session with a debounce.
 *
 * @param {string} sessionId - The ID of the session to invalidate.
 * @param {string[]} [changedFiles] - Optional list of changed file paths relative to repo root.
 *   When provided, the UI can fetch only those files' diffs instead of the full diff.
 *   Pass an empty array or omit to signal a full-diff refresh.
 */
export function debouncedDiffInvalidation(sessionId, changedFiles) {
  if (diffTimers.has(sessionId)) clearTimeout(diffTimers.get(sessionId));
  diffTimers.set(
    sessionId,
    setTimeout(() => {
      diffTimers.delete(sessionId);
      broadcastToSession(sessionId, {
        type: "diff:invalidated",
        sessionId,
        changedFiles: changedFiles ?? [],
      });
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
  if (message?.type === "diff:invalidated") {
    invalidateSessionDiffCache(message.sessionId);
  }
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
  if (message?.type === "diff:invalidated") {
    invalidateSessionDiffCache(sessionId || message.sessionId);
  }
  const io = getIO();
  if (!io) return;
  try {
    io.to(`session:${sessionId}`).emit("message", message);
  } catch (err) {
    console.warn("[ws] broadcastToSession failed:", err.message);
  }
}
