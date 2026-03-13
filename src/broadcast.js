/** @type {Set<import("ws").WebSocket>} */
export const wsClients = new Set();

const MAX_BUFFER = 1 * 1024 * 1024;

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
      broadcast({ type: "diff:invalidated", sessionId });
    }, 300),
  );
}

/** Cancel all pending diff debounce timers (used during shutdown). */
export function clearDiffTimers() {
  for (const timer of diffTimers.values()) clearTimeout(timer);
  diffTimers.clear();
}

export function broadcast(message) {
  let data;
  try {
    data = JSON.stringify(message);
  } catch (err) {
    console.warn("[ws] broadcast skipped — JSON.stringify failed:", err.message);
    return;
  }
  // Set deletion during iteration is safe per the ES spec: deleted entries
  // that have not yet been visited are simply skipped by the iterator.
  for (const client of wsClients) {
    if (client.readyState === 3) {
      wsClients.delete(client);
      continue;
    }
    if (client.readyState === 1) {
      if (client.bufferedAmount > MAX_BUFFER) {
        console.warn("[ws] terminating slow client (buffered:", client.bufferedAmount, "bytes)");
        wsClients.delete(client);
        client.terminate();
        continue;
      }
      try {
        client.send(data);
      } catch (err) {
        console.warn("[ws] removing client after send error:", err.message);
        wsClients.delete(client);
      }
    }
  }
}
