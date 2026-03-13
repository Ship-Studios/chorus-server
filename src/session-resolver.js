import { execFileSync } from "node:child_process";
import { GIT } from "./git.js";
import {
  getAlias,
  insertAlias,
  findActiveSessionByDir,
  findRecentSessionByDir,
  findActiveSessionByGitRoot,
  findRecentSessionByGitRoot,
  upsertSession,
  runInTransaction,
} from "./db.js";

/**
 * Resolves a directory to its git repository's main working tree root.
 * For worktrees, this returns the parent repo's root directory.
 * For normal repos, this returns the repo root itself.
 * Returns null if the directory is not a git repo.
 *
 * @param {string} dir - The directory to resolve
 * @returns {string|null} The main working tree root, or null
 */
function resolveGitRoot(dir) {
  try {
    // Check if dir is inside a git submodule FIRST, before worktree list.
    // `git worktree list` inside a submodule returns the gitdir path
    // (.git/modules/...), not the working tree — and calling
    // --show-superproject-working-tree from a gitdir returns empty.
    // So we must check from the original working tree dir.
    try {
      const superproject = execFileSync(
        GIT,
        ["rev-parse", "--show-superproject-working-tree"],
        { cwd: dir, encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] },
      ).trim();
      if (superproject) return superproject;
    } catch {
      // Not a submodule — continue with normal worktree resolution
    }

    // --show-superproject-working-tree returns empty for non-submodules,
    // so we use worktree list which always shows the main tree first.
    const output = execFileSync(GIT, ["worktree", "list", "--porcelain"], {
      cwd: dir,
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // First "worktree <path>" line is always the main working tree
    const match = output.match(/^worktree (.+)$/m);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// Cache git root lookups to avoid repeated execSync calls.
// Capped at 200 entries — oldest evicted when full.
const GIT_ROOT_CACHE_MAX = 200;
const gitRootCache = new Map();

function cachedGitRoot(dir) {
  if (gitRootCache.has(dir)) return gitRootCache.get(dir);
  const root = resolveGitRoot(dir);
  if (gitRootCache.size >= GIT_ROOT_CACHE_MAX) {
    // Evict oldest entry (first key in insertion order)
    const firstKey = gitRootCache.keys().next().value;
    gitRootCache.delete(firstKey);
  }
  gitRootCache.set(dir, root);
  // Also cache the root → root mapping
  if (root && root !== dir) gitRootCache.set(root, root);
  return root;
}

/**
 * Finds a session whose project_dir shares the same git root as the given dir.
 * Checks active sessions first, then recent ones.
 *
 * @param {string} dir - The directory to match
 * @param {string} gitRoot - The resolved git root for dir
 * @returns {{ id: string } | null}
 */
function findSessionByGitRoot(dir, gitRoot) {
  // Check active sessions
  for (const row of findActiveSessionByGitRoot.all()) {
    if (row.project_dir === dir) continue; // Already checked by exact match
    const rowRoot = cachedGitRoot(row.project_dir);
    if (rowRoot && rowRoot === gitRoot) return row;
  }
  // Check recent sessions
  for (const row of findRecentSessionByGitRoot.all()) {
    if (row.project_dir === dir) continue;
    const rowRoot = cachedGitRoot(row.project_dir);
    if (rowRoot && rowRoot === gitRoot) return row;
  }
  return null;
}

/**
 * Resolves a Claude Code CLI session_id to a stable dashboard session ID.
 *
 * Resolution order:
 * 1. Check if this claude_session_id already has an alias → return it
 * 2. Check if there's an active session for the same project_dir → alias to it
 * 3. Check if there's any recent session for the same project_dir → alias to it
 * 4. Check if there's a session for the same git repo root (worktree support) → alias to it
 * 5. No match → this claude_session_id becomes its own dashboard session (new session)
 *
 * @param {string} claudeSessionId - The session_id from the Claude Code hook payload
 * @param {string} projectDir - The project directory
 * @returns {string} The canonical dashboard session ID
 */
export function resolveSessionId(claudeSessionId, projectDir) {
  // Pre-compute git root OUTSIDE the transaction — cachedGitRoot may shell out
  // to `git worktree list`, and we must not hold a SQLite write lock during I/O.
  const needsGitRoot = projectDir && projectDir !== "unknown";
  const gitRoot = needsGitRoot ? cachedGitRoot(projectDir) : null;

  // Pre-compute git root session match outside transaction too (also shells out)
  let gitRootMatch = null;
  if (gitRoot && gitRoot !== projectDir) {
    gitRootMatch = findSessionByGitRoot(projectDir, gitRoot);
  }

  return runInTransaction(() => {
    // 1. Already mapped?
    const existing = getAlias.get({ $claudeSessionId: claudeSessionId });
    if (existing) {
      return existing.dashboard_session_id;
    }

    if (needsGitRoot) {
      // 2. Active session for the same project dir?
      const active = findActiveSessionByDir.get({ $projectDir: projectDir });
      if (active) {
        insertAlias.run({
          $claudeSessionId: claudeSessionId,
          $dashboardSessionId: active.id,
        });
        return active.id;
      }

      // 3. Any recent session for the same project dir?
      const recent = findRecentSessionByDir.get({ $projectDir: projectDir });
      if (recent) {
        insertAlias.run({
          $claudeSessionId: claudeSessionId,
          $dashboardSessionId: recent.id,
        });
        return recent.id;
      }

      // 4. Check git repo root match (pre-computed outside transaction)
      if (gitRootMatch) {
        insertAlias.run({
          $claudeSessionId: claudeSessionId,
          $dashboardSessionId: gitRootMatch.id,
        });
        return gitRootMatch.id;
      }
    }

    // 5. New session — alias to itself AND create the session row atomically.
    insertAlias.run({
      $claudeSessionId: claudeSessionId,
      $dashboardSessionId: claudeSessionId,
    });
    upsertSession.run({
      $id: claudeSessionId,
      $projectDir: projectDir || "unknown",
      $worktreeDir: null,
      $status: "active",
      $model: null,
      $currentClaudeSessionId: claudeSessionId,
    });
    return claudeSessionId;
  });
}

/**
 * Resolves a Claude Code session_id to its dashboard session ID (read-only).
 * Used by event and stop handlers where we don't want to create new sessions.
 * Falls back to the input ID if no alias exists.
 */
export function lookupSessionId(claudeSessionId) {
  const existing = getAlias.get({ $claudeSessionId: claudeSessionId });
  return existing ? existing.dashboard_session_id : claudeSessionId;
}
