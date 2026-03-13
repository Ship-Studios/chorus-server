import chokidar from "chokidar";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { broadcast } from "./broadcast.js";

/** @type {Map<string, { watcher: import("chokidar").FSWatcher, sessionIds: Set<string>, debounceTimer: ReturnType<typeof setTimeout> | null }>} */
const watchers = new Map();

/**
 * Start watching a project directory's .git internals for changes.
 * Deduplicates by directory — multiple sessions on the same repo share one watcher.
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
        broadcast({ type: "diff:invalidated", sessionId: sid });
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
 * Close all watchers on server shutdown.
 */
export function shutdownWatchers() {
  for (const [, entry] of watchers) {
    if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
    entry.watcher.close();
  }
  watchers.clear();
}
