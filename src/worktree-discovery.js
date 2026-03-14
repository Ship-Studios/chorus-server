import { runGit } from "@agent-dashboard/diff-panel/server";
import { parseWorktreeListPorcelain } from "./git-worktree.js";

const CACHE_TTL_MS = 5_000;

const cache = new Map();
const inflight = new Map();

export function invalidateDiscoveredWorktrees(repoDir) {
  if (!repoDir) return;
  cache.delete(repoDir);
  inflight.delete(repoDir);
}

export async function getDiscoveredWorktrees(repoDir) {
  const cached = cache.get(repoDir);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.entries;
  }

  if (inflight.has(repoDir)) {
    return inflight.get(repoDir);
  }

  const promise = runGit(repoDir, ["worktree", "list", "--porcelain"])
    .then((output) => {
      const entries = parseWorktreeListPorcelain(output);
      cache.set(repoDir, { entries, timestamp: Date.now() });
      return entries;
    })
    .finally(() => {
      inflight.delete(repoDir);
    });

  inflight.set(repoDir, promise);
  return promise;
}
