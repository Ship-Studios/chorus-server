import chokidar from "chokidar";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { debouncedDiffInvalidation } from "./broadcast.js";

/** @type {Map<string, { watcher: import("chokidar").FSWatcher, sessionIds: Set<string>, debounceTimer: ReturnType<typeof setTimeout> | null }>} */
const watchers = new Map();

/**
 * Start watching a project directory's .git internals for changes.
 * Deduplicates by directory — multiple sessions on the same repo share one watcher.
 *
 * @param {string} sessionId - The ID of the session.
 * @param {string} projectDir - The directory to watch.
 */
export function startWatching(sessionId, projectDir) {
  if (!projectDir || projectDir === "unknown") return;

  const gitDir = join(projectDir, ".git");
  if (!existsSync(gitDir)) return;

  // If watcher already exists for this dir, just register the session
  if (watchers.has(projectDir)) {
    watchers.get(projectDir).sessionIds.add(sessionId);
    return;
  }

  const watchPaths = [
    join(gitDir, "HEAD"),
    join(gitDir, "index"),
    join(gitDir, "refs", "heads"),
    join(gitDir, "refs", "stash"),
  ];

  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100 },
  });

  const entry = { watcher, sessionIds: new Set([sessionId]), debounceTimer: null };

  watcher.on("all", () => {
    // Debounce 300ms — git operations touch multiple files in sequence
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = null;
      for (const sid of entry.sessionIds) {
        debouncedDiffInvalidation(sid);
      }
    }, 300);
  });

  watcher.on("error", (err) => {
    console.warn(`[git-watcher] error for ${projectDir}:`, err.message);
  });

  watchers.set(projectDir, entry);
}

/**
 * Stop watching for a session. Closes the watcher if no sessions remain.
 *
 * @param {string} sessionId - The ID of the session.
 * @param {string} projectDir - The directory that was being watched.
 */
export function stopWatching(sessionId, projectDir) {
  if (!projectDir || !watchers.has(projectDir)) return;
  const entry = watchers.get(projectDir);
  entry.sessionIds.delete(sessionId);

  if (entry.sessionIds.size === 0) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.watcher.close();
    watchers.delete(projectDir);
  }
}

/**
 * Restore watchers for all sessions on server startup.
 *
 * @param {Array<object>} sessions - A list of session objects.
 */
export function initWatchers(sessions) {
  for (const session of sessions) {
    const dir = session.worktree_dir || session.project_dir;
    startWatching(session.id, dir);
  }
  if (sessions.length > 0) {
    console.log(`[git-watcher] initialized ${watchers.size} watcher(s) for ${sessions.length} session(s)`);
  }
}

/**
 * Close all watchers on server shutdown to ensure a clean exit.
 */
export function shutdownWatchers() {
  for (const [, entry] of watchers) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.watcher.close();
  }
  watchers.clear();
}
