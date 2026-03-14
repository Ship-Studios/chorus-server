import { execFileSync, spawn } from "node:child_process";
import { join } from "node:path";
import { GIT } from "./git.js";

const DEFAULT_GIT_TIMEOUT = 15000;
const MAX_GIT_BUFFER = 10 * 1024 * 1024;

function createGitError(args, code, stdout, stderr, message) {
  const err = new Error(message || stderr.trim() || stdout.trim() || `git ${args[0]} exited with code ${code}`);
  err.code = code;
  err.stdout = stdout;
  err.stderr = stderr;
  return err;
}

function getGitErrorMessage(err) {
  if (!err) return "Unknown git error";
  if (typeof err.stderr === "string" && err.stderr.trim()) return err.stderr.trim();
  if (typeof err.stdout === "string" && err.stdout.trim()) return err.stdout.trim();
  return err.message || String(err);
}

function parseNumstat(numstatOutput) {
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  for (const line of numstatOutput.split("\n")) {
    if (!line.trim()) continue;
    const [add, del] = line.split("\t");
    filesChanged++;
    insertions += parseInt(add, 10) || 0;
    deletions += parseInt(del, 10) || 0;
  }

  return { filesChanged, insertions, deletions };
}

function runGitAsync(cwd, args, { timeout = DEFAULT_GIT_TIMEOUT, env } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(GIT, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let settled = false;

    const finishResolve = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };

    const timer = setTimeout(() => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      proc.kill("SIGTERM");
      finishReject(createGitError(args, null, stdout, stderr, `git ${args[0]} timed out after ${timeout}ms`));
    }, timeout);

    proc.stdout.on("data", (chunk) => {
      stdoutLen += chunk.length;
      if (stdoutLen > MAX_GIT_BUFFER) {
        const stdout = Buffer.concat([...stdoutChunks, chunk]).toString("utf-8");
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        proc.kill("SIGTERM");
        finishReject(createGitError(args, null, stdout, stderr, `git ${args[0]} output exceeded ${MAX_GIT_BUFFER} bytes`));
        return;
      }
      stdoutChunks.push(chunk);
    });

    proc.stderr.on("data", (chunk) => {
      stderrLen += chunk.length;
      if (stderrLen > MAX_GIT_BUFFER) {
        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        const stderr = Buffer.concat([...stderrChunks, chunk]).toString("utf-8");
        proc.kill("SIGTERM");
        finishReject(createGitError(args, null, stdout, stderr, `git ${args[0]} stderr exceeded ${MAX_GIT_BUFFER} bytes`));
        return;
      }
      stderrChunks.push(chunk);
    });

    proc.on("error", (err) => {
      finishReject(new Error(`Failed to spawn git: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (settled) return;
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      if (code === 0) {
        finishResolve({ stdout, stderr });
        return;
      }
      finishReject(createGitError(args, code, stdout, stderr));
    });
  });
}

async function getCurrentBranchAsync(repoDir) {
  try {
    const { stdout } = await runGitAsync(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"], {
      timeout: 5000,
    });
    return stdout.trim();
  } catch {
    return "main";
  }
}

/**
 * Slugify a description for use as a git branch name.
 *
 * @param {string} desc - The description to slugify.
 * @returns {string} The slugified branch name.
 */
export function slugify(desc) {
  return desc
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);
}

/**
 * Get the current branch name of the repository.
 *
 * @deprecated Use `getCurrentBranchAsync` instead to avoid blocking the event loop.
 * @param {string} repoDir - The path to the git repository.
 * @returns {string} The current branch name (defaults to 'main' on error).
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
 * @param {string} repoDir - The git repository root.
 * @param {string} id - Unique identifier for the worktree.
 * @param {string} description - Human-readable description (used to generate branch name).
 * @returns {Promise<{ worktreePath: string, branchName: string, baseBranch: string }>}
 */
export async function createWorktree(repoDir, id, description) {
  // Always resolve to a stable base branch — never use an agent/ branch as base,
  // since the current HEAD might be a transient agent worktree branch.
  const currentBranch = await getCurrentBranchAsync(repoDir);
  const baseBranch = currentBranch.startsWith("agent/") ? "main" : currentBranch;
  const slug = slugify(description || id);
  const branchName = `agent/${slug}-${id.slice(0, 6)}`;
  const worktreePath = join(repoDir, "..", `.swarm-worktree-${id}`);

  await runGitAsync(repoDir, ["worktree", "add", "-b", branchName, worktreePath, baseBranch], {
    timeout: 15000,
  });

  return { worktreePath, branchName, baseBranch };
}

/**
 * Delay execution for a given number of milliseconds.
 *
 * @param {number} ms - The number of milliseconds to delay.
 * @returns {Promise<void>}
 */
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
      await runGitAsync(repoDir, ["worktree", "remove", "--force", worktreePath], {
        timeout: 15000,
      });
      return; // success
    } catch (err) {
      const msg = getGitErrorMessage(err);
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
 * Delete a git branch asynchronously.
 * @param {string} repoDir
 * @param {string} branchName
 * @returns {Promise<void>}
 */
export async function deleteBranchAsync(repoDir, branchName) {
  try {
    await runGitAsync(repoDir, ["branch", "-D", branchName], {
      timeout: 5000,
    });
  } catch (err) {
    console.error(`[worktree] Failed to delete branch ${branchName}: ${getGitErrorMessage(err)}`);
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

    return { ...parseNumstat(numstat), diffStat: stat };
  } catch (err) {
    const msg = err.stderr?.toString?.().trim() || err.message || String(err);
    console.error(`[worktree] getBranchDiffStats failed for ${baseBranch}...${headBranch} in ${repoDir}: ${msg}`);
    return { filesChanged: 0, insertions: 0, deletions: 0, diffStat: "" };
  }
}

/**
 * Get diff stats between two branches asynchronously.
 * @param {string} repoDir
 * @param {string} baseBranch
 * @param {string} headBranch
 * @returns {Promise<{ filesChanged: number, insertions: number, deletions: number, diffStat: string }>}
 */
export async function getBranchDiffStatsAsync(repoDir, baseBranch, headBranch) {
  try {
    const [{ stdout: stat }, { stdout: numstat }] = await Promise.all([
      runGitAsync(repoDir, ["diff", "--stat", "--no-color", `${baseBranch}...${headBranch}`], {
        timeout: 10000,
      }),
      runGitAsync(repoDir, ["diff", "--numstat", `${baseBranch}...${headBranch}`], {
        timeout: 10000,
      }),
    ]);

    return { ...parseNumstat(numstat.trim()), diffStat: stat.trim() };
  } catch (err) {
    const msg = getGitErrorMessage(err);
    console.error(`[worktree] getBranchDiffStats failed for ${baseBranch}...${headBranch} in ${repoDir}: ${msg}`);
    return { filesChanged: 0, insertions: 0, deletions: 0, diffStat: "" };
  }
}

/**
 * Parse `git worktree list --porcelain` output into an array of { path, branch } entries.
 * Skips the first entry (always the main worktree).
 * @param {string} porcelainOutput - Raw output from `git worktree list --porcelain`
 * @returns {{ path: string, branch: string }[]}
 */
export function parseWorktreeListPorcelain(porcelainOutput) {
  const entries = [];
  let isFirst = true;
  let currentPath = null;
  let currentBranch = null;
  for (const line of porcelainOutput.split("\n")) {
    if (line.startsWith("worktree ")) {
      currentPath = line.slice(9).trim();
      currentBranch = null;
    } else if (line.startsWith("branch refs/heads/")) {
      currentBranch = line.slice("branch refs/heads/".length).trim();
    } else if (line === "") {
      if (isFirst) {
        isFirst = false;
      } else if (currentPath && currentBranch) {
        entries.push({ path: currentPath, branch: currentBranch });
      }
      currentPath = null;
      currentBranch = null;
    }
  }
  return entries;
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

/**
 * Check for merge conflicts between a branch and its base using git merge-tree.
 * Returns a conflict description string, or null if clean.
 * @param {string} repoDir
 * @param {string} baseBranch
 * @param {string} headBranch
 * @returns {Promise<string | null>}
 */
export async function detectConflictsAsync(repoDir, baseBranch, headBranch) {
  try {
    await runGitAsync(repoDir, ["merge-tree", "--write-tree", baseBranch, headBranch], {
      timeout: 15000,
    });
    return null;
  } catch (err) {
    const output = typeof err.stdout === "string" && err.stdout ? err.stdout : err.message || String(err);
    const conflicts = [];
    for (const line of output.split("\n")) {
      if (line.startsWith("CONFLICT")) {
        conflicts.push(line);
      }
    }
    return conflicts.length > 0 ? conflicts.join("\n") : "Merge conflicts detected";
  }
}

/**
 * Stage and commit any worktree changes using the dashboard's synthetic git identity.
 * Non-committable states such as "nothing to commit" are treated as success.
 * @param {string} worktreePath
 * @param {string} description
 * @param {string} id
 * @param {string | null} branchName
 * @returns {Promise<void>}
 */
export async function autoCommitWorktree(worktreePath, description, id, branchName) {
  try {
    const { stdout } = await runGitAsync(worktreePath, ["status", "--porcelain"], {
      timeout: 5000,
    });
    const statusOut = stdout.trim();
    if (!statusOut) {
      console.log(`[swarm:${id}] No changes to commit in worktree`);
    } else {
      console.log(`[swarm:${id}] Staging ${statusOut.split("\n").length} changed file(s)`);
    }

    await runGitAsync(worktreePath, ["add", "-A"], {
      timeout: 10000,
    });
    await runGitAsync(worktreePath, ["commit", "-m", `agent: ${description || id}`], {
      timeout: 10000,
      env: {
        GIT_AUTHOR_NAME: "Agent",
        GIT_COMMITTER_NAME: "Agent",
        GIT_AUTHOR_EMAIL: "agent@dashboard",
        GIT_COMMITTER_EMAIL: "agent@dashboard",
      },
    });
    console.log(`[swarm:${id}] Committed agent changes to branch ${branchName}`);
  } catch (err) {
    const msg = getGitErrorMessage(err);
    if (!msg.includes("nothing to commit") && !msg.includes("nothing added to commit")) {
      console.warn(`[swarm:${id}] Auto-commit warning: ${msg}`);
    }
  }
}
