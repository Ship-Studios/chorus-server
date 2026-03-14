import { basename, dirname, resolve as resolvePath } from "node:path";
import { runGit } from "./run-git.js";
import {
  getAlias,
  insertAlias,
  findActiveSessionByDir,
  findRecentSessionByDir,
  findActiveSessionByGitRoot,
  findRecentSessionByGitRoot,
  updateSessionGitRoot,
  upsertSession,
  runInTransaction,
} from "./db.js";

const GIT_ROOT_CACHE_MAX = 200;
const GIT_ROOT_CACHE_TTL_MS = 5 * 60_000;

const gitRootCache = new Map();
const inflightGitRoots = new Map();

function getCachedGitRoot(dir) {
  const entry = gitRootCache.get(dir);
  if (!entry) return undefined;
  if (Date.now() - entry.timestamp > GIT_ROOT_CACHE_TTL_MS) {
    gitRootCache.delete(dir);
    return undefined;
  }
  return entry.value;
}

function setCachedGitRoot(dir, value) {
  if (gitRootCache.size >= GIT_ROOT_CACHE_MAX) {
    const firstKey = gitRootCache.keys().next().value;
    gitRootCache.delete(firstKey);
  }
  gitRootCache.set(dir, { value, timestamp: Date.now() });
}

/**
 * Resolves the git root info for a directory.
 * Returns { root, topLevel } where:
 *   root     — the common .git parent (same for all worktrees of the same repo)
 *   topLevel — the working tree root for THIS checkout (differs per worktree)
 *
 * The distinction is used to determine whether git-root matching should fire:
 * only sessions where projectDir === topLevel (i.e. Claude runs at a checkout root,
 * not inside a monorepo subdirectory) are eligible for git-root aliasing.
 */
async function resolveGitRoot(dir) {
  // Always resolve topLevel first — it is carried in all return paths.
  let topLevel = null;
  try {
    topLevel = (await runGit(dir, ["rev-parse", "--show-toplevel"], { timeout: 3_000 })).trim() || null;
  } catch {
    // Not a git repo (or git unavailable). topLevel stays null.
  }

  try {
    const superproject = (await runGit(dir, ["rev-parse", "--show-superproject-working-tree"], {
      timeout: 3_000,
    })).trim();
    // Submodule: root is the parent repo; topLevel is also the parent repo root for
    // the purpose of the useGitRootMatch guard (submodule sessions should not be
    // merged with sibling packages via git-root matching).
    if (superproject) return { root: superproject, topLevel: superproject };
  } catch {
    // Not a submodule.
  }

  try {
    const commonDir = resolvePath(
      dir,
      (await runGit(dir, ["rev-parse", "--git-common-dir"], { timeout: 3_000 })).trim(),
    );
    if (basename(commonDir) === ".git") {
      // Linked worktree: root = main repo, topLevel = this worktree's checkout root.
      return { root: dirname(commonDir), topLevel };
    }
  } catch {
    // Fall through to the plain repo path.
  }

  return topLevel ? { root: topLevel, topLevel } : null;
}

async function cachedGitRoot(dir) {
  const cached = getCachedGitRoot(dir);
  if (cached !== undefined) return cached;

  if (inflightGitRoots.has(dir)) {
    return inflightGitRoots.get(dir);
  }

  const promise = resolveGitRoot(dir)
    .then((info) => {
      setCachedGitRoot(dir, info);
      if (info?.root && info.root !== dir) {
        // Pre-cache the repo root itself so sessions running at the repo root
        // get an instant cache hit on their next call.
        setCachedGitRoot(info.root, { root: info.root, topLevel: info.root });
      }
      return info;
    })
    .finally(() => {
      inflightGitRoots.delete(dir);
    });

  inflightGitRoots.set(dir, promise);
  return promise;
}

function scheduleGitRootHydration(sessionId, projectDir) {
  if (!projectDir || projectDir === "unknown") return;
  cachedGitRoot(projectDir)
    .then((info) => {
      if (info?.root) {
        updateSessionGitRoot.run({ $id: sessionId, $gitRoot: info.root });
      }
    })
    .catch(() => {});
}

/**
 * Resolves a Claude Code CLI session_id to a stable dashboard session ID.
 *
 * Resolution order:
 * 1. Check if this claude_session_id already has an alias → return it
 * 2. Check if there's an active session for the same project_dir → alias to it
 * 3. Check if there's any recent session for the same project_dir → alias to it
 * 4. Check if there's a session for the same git repo root — only when projectDir === topLevel
 *    (i.e. Claude runs at a checkout root). Monorepo subdirectory sessions are excluded.
 * 5. No match → this claude_session_id becomes its own dashboard session
 *
 * Git-root matching is async and promise-deduped so hook handlers no longer block
 * the event loop on synchronous git subprocesses.
 *
 * @param {string} claudeSessionId - The session_id from the Claude Code hook payload
 * @param {string} projectDir - The project directory
 * @returns {Promise<string>} The canonical dashboard session ID
 */
export async function resolveSessionId(claudeSessionId, projectDir) {
  const needsProjectDir = projectDir && projectDir !== "unknown";

  const directMatch = runInTransaction(() => {
    const existing = getAlias.get({ $claudeSessionId: claudeSessionId });
    if (existing) {
      return { id: existing.dashboard_session_id, git_root: null };
    }

    if (!needsProjectDir) return null;

    const active = findActiveSessionByDir.get({ $projectDir: projectDir });
    if (active) {
      insertAlias.run({
        $claudeSessionId: claudeSessionId,
        $dashboardSessionId: active.id,
      });
      return active;
    }

    const recent = findRecentSessionByDir.get({ $projectDir: projectDir });
    if (recent) {
      insertAlias.run({
        $claudeSessionId: claudeSessionId,
        $dashboardSessionId: recent.id,
      });
      return recent;
    }

    return null;
  });

  if (directMatch) {
    if (needsProjectDir && !directMatch.git_root) {
      scheduleGitRootHydration(directMatch.id, projectDir);
    }
    return directMatch.id;
  }

  const gitRootInfo = needsProjectDir ? await cachedGitRoot(projectDir) : null;
  const gitRoot = gitRootInfo?.root ?? null;
  const topLevel = gitRootInfo?.topLevel ?? null;

  // Git-root matching is only valid when Claude is running at the checkout root
  // (projectDir === topLevel). If Claude runs inside a monorepo subdirectory
  // (e.g. /repo/packages/server), topLevel would be /repo but projectDir would
  // be /repo/packages/server — these are independent workstreams and must NOT
  // be merged just because they share the same repo root.
  const useGitRootMatch = gitRoot !== null && projectDir === topLevel;

  return runInTransaction(() => {
    const existing = getAlias.get({ $claudeSessionId: claudeSessionId });
    if (existing) {
      return existing.dashboard_session_id;
    }

    if (needsProjectDir) {
      const active = findActiveSessionByDir.get({ $projectDir: projectDir });
      if (active) {
        insertAlias.run({
          $claudeSessionId: claudeSessionId,
          $dashboardSessionId: active.id,
        });
        if (!active.git_root && gitRoot) {
          updateSessionGitRoot.run({ $id: active.id, $gitRoot: gitRoot });
        }
        return active.id;
      }

      const recent = findRecentSessionByDir.get({ $projectDir: projectDir });
      if (recent) {
        insertAlias.run({
          $claudeSessionId: claudeSessionId,
          $dashboardSessionId: recent.id,
        });
        if (!recent.git_root && gitRoot) {
          updateSessionGitRoot.run({ $id: recent.id, $gitRoot: gitRoot });
        }
        return recent.id;
      }

      if (useGitRootMatch) {
        const activeRoot = findActiveSessionByGitRoot.get({ $gitRoot: gitRoot });
        if (activeRoot) {
          insertAlias.run({
            $claudeSessionId: claudeSessionId,
            $dashboardSessionId: activeRoot.id,
          });
          return activeRoot.id;
        }

        const recentRoot = findRecentSessionByGitRoot.get({ $gitRoot: gitRoot });
        if (recentRoot) {
          insertAlias.run({
            $claudeSessionId: claudeSessionId,
            $dashboardSessionId: recentRoot.id,
          });
          return recentRoot.id;
        }
      }
    }

    insertAlias.run({
      $claudeSessionId: claudeSessionId,
      $dashboardSessionId: claudeSessionId,
    });
    upsertSession.run({
      $id: claudeSessionId,
      $projectDir: projectDir || "unknown",
      $worktreeDir: null,
      $gitRoot: gitRoot,
      $status: "active",
      $model: null,
      $currentClaudeSessionId: claudeSessionId,
    });
    return claudeSessionId;
  });
}

/**
 * Resolves a Claude Code session_id to its dashboard session ID (read-only).
 *
 * @param {string} claudeSessionId - The Claude Code session ID to look up
 * @returns {string} The canonical dashboard session ID
 */
export function lookupSessionId(claudeSessionId) {
  const existing = getAlias.get({ $claudeSessionId: claudeSessionId });
  return existing ? existing.dashboard_session_id : claudeSessionId;
}
