import { getIO } from "./socket.js";
import { getSession } from "./db-adapter.js";
import { invalidateDiffCache } from "./diff-cache.js";

// --- Debounced diff invalidation ---
// Multiple sources fire diff:invalidated for the same underlying change (hook,
// diff-watcher, prompt:done). Coalesce per-session with a 300ms trailing-edge
// debounce so the UI receives at most one signal per burst.
const diffTimers = new Map();

async function invalidateSessionDiffCache(sessionId) {
  const session = sessionId ? await getSession(sessionId) : null;
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
    invalidateSessionDiffCache(message.sessionId).catch(() => {});
  }
  const io = getIO();
  if (!io) return;
  try {
    io.emit("message", message);
  } catch (err) {
    console.warn("[ws] broadcast failed:", err.message);
  }
}

// --- Broadcast interceptors ---
// Modules can register callbacks to observe messages passing through
// broadcastToSession without modifying bridge.js or other emitters.
/** @type {Set<(sessionId: string, message: object) => void>} */
const broadcastInterceptors = new Set();

/**
 * Register a callback that is invoked every time `broadcastToSession` fires.
 * Used by prompt-adapter.js to clean up tracking maps when bridge lifecycle
 * events (prompt:done, swarm:done) arrive.
 *
 * @param {(sessionId: string, message: object) => void} fn
 * @returns {() => void} Unregister function
 */
export function onBroadcastToSession(fn) {
  broadcastInterceptors.add(fn);
  return () => broadcastInterceptors.delete(fn);
}

/**
 * Broadcasts a message only to clients subscribed to a specific session room.
 * Used for session-specific events like prompt:*, swarm:*, diff:*, worktree:*.
 *
 * @param {string} sessionId - The ID of the session room to broadcast to.
 * @param {object} message - The message object to broadcast.
 */
export function broadcastToSession(sessionId, message) {
  // Notify interceptors (fire-and-forget, errors logged but swallowed)
  for (const fn of broadcastInterceptors) {
    try { fn(sessionId, message); } catch (_) { /* swallow */ }
  }
  if (message?.type === "diff:invalidated") {
    invalidateSessionDiffCache(sessionId || message.sessionId).catch(() => {});
  }
  const io = getIO();
  if (!io) return;
  try {
    io.to(`session:${sessionId}`).emit("message", message);
  } catch (err) {
    console.warn("[ws] broadcastToSession failed:", err.message);
  }
}
