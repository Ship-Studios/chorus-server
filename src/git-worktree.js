import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { GIT } from "./git.js";

/**
 * Slugify a description for use as a git branch name.
 * @param {string} desc
 * @returns {string}
 */
export function slugify(desc) {
  return desc
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

/**
 * Get the current branch name of the repo.
 * @param {string} repoDir
 * @returns {string}
 */
export function getCurrentBranch(repoDir) {
  try {
    return execFileSync(GIT, ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "main";
  }
}

/**
 * Create a git worktree with a named branch from the given repo directory.
 * Returns { worktreePath, branchName, baseBranch } on success, or throws on failure.
 *
 * @param {string} repoDir - The git repository root
 * @param {string} id - Unique identifier for the worktree
 * @param {string} description - Human-readable description (used to generate branch name)
 * @returns {{ worktreePath: string, branchName: string, baseBranch: string }}
 */
export function createWorktree(repoDir, id, description) {
  // Always resolve to a stable base branch — never use an agent/ branch as base,
  // since the current HEAD might be a transient agent worktree branch.
  const currentBranch = getCurrentBranch(repoDir);
  const baseBranch = currentBranch.startsWith("agent/") ? "main" : currentBranch;
  const slug = slugify(description || id);
  const branchName = `agent/${slug}-${id.slice(0, 6)}`;
  const worktreePath = join(repoDir, "..", `.swarm-worktree-${id}`);

  execFileSync(GIT, ["worktree", "add", "-b", branchName, worktreePath, baseBranch], {
    cwd: repoDir,
    stdio: "pipe",
    timeout: 15000,
  });

  return { worktreePath, branchName, baseBranch };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Remove a git worktree checkout but preserve the branch.
 * Retries with a non-blocking delay if the worktree is still locked.
 * @param {string} repoDir - The git repository root
 * @param {string} worktreePath - The worktree to remove
 */
export async function removeWorktree(repoDir, worktreePath) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      execFileSync(GIT, ["worktree", "remove", "--force", worktreePath], {
        cwd: repoDir,
        stdio: "pipe",
        timeout: 15000,
      });
      return; // success
    } catch (err) {
      const msg = err.stderr?.toString?.() || err.message;
      if (attempt < maxAttempts) {
        // Hook scripts run curl in background (&) which may still hold the worktree
        // CWD open briefly after the claude process exits. Retry after a short pause.
        console.warn(`[worktree] Remove attempt ${attempt}/${maxAttempts} failed for ${worktreePath}: ${msg.trim()}`);
        await delay(1500);
      } else {
        console.error(`[worktree] Failed to remove ${worktreePath} after ${maxAttempts} attempts: ${msg.trim()}`);
      }
    }
  }
}

/**
 * Delete a git branch.
 * @param {string} repoDir
 * @param {string} branchName
 */
export function deleteBranch(repoDir, branchName) {
  try {
    execFileSync(GIT, ["branch", "-D", branchName], {
      cwd: repoDir,
      stdio: "pipe",
      timeout: 5000,
    });
  } catch (err) {
    console.error(`[worktree] Failed to delete branch ${branchName}: ${err.message}`);
  }
}

/**
 * Get diff stats between two branches.
 * @param {string} repoDir
 * @param {string} baseBranch
 * @param {string} headBranch
 * @returns {{ filesChanged: number, insertions: number, deletions: number, diffStat: string }}
 */
export function getBranchDiffStats(repoDir, baseBranch, headBranch) {
  try {
    const stat = execFileSync(GIT, ["diff", "--stat", "--no-color", `${baseBranch}...${headBranch}`], {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const numstat = execFileSync(GIT, ["diff", "--numstat", `${baseBranch}...${headBranch}`], {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    let filesChanged = 0, insertions = 0, deletions = 0;
    for (const line of numstat.split("\n")) {
      if (!line.trim()) continue;
      const [add, del] = line.split("\t");
      filesChanged++;
      insertions += parseInt(add, 10) || 0;
      deletions += parseInt(del, 10) || 0;
    }

    return { filesChanged, insertions, deletions, diffStat: stat };
  } catch {
    return { filesChanged: 0, insertions: 0, deletions: 0, diffStat: "" };
  }
}

/**
 * Check for merge conflicts between a branch and its base using git merge-tree.
 * Returns a conflict description string, or null if clean.
 * @param {string} repoDir
 * @param {string} baseBranch
 * @param {string} headBranch
 * @returns {string | null}
 */
export function detectConflicts(repoDir, baseBranch, headBranch) {
  try {
    // git merge-tree --write-tree exits non-zero if there are conflicts
    execFileSync(GIT, ["merge-tree", "--write-tree", baseBranch, headBranch], {
      cwd: repoDir,
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return null; // clean merge
  } catch (err) {
    const output = err.stdout?.toString?.() || err.message;
    // Extract conflicted file names
    const conflicts = [];
    for (const line of output.split("\n")) {
      if (line.startsWith("CONFLICT")) {
        conflicts.push(line);
      }
    }
    return conflicts.length > 0 ? conflicts.join("\n") : "Merge conflicts detected";
  }
}
