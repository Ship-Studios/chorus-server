import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  autoCommitWorktree,
  createWorktree,
  detectConflictsAsync,
  getBranchDiffStatsAsync,
  removeWorktree,
  slugify,
} from "./git-worktree.js";
import { GIT } from "./git.js";

const TEMP_REPO = join(import.meta.dir, "..", ".test-git-worktree-repo");

function git(args, cwd = TEMP_REPO) {
  return execFileSync(GIT, args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: 10000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_COMMITTER_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_EMAIL: "test@test.com",
    },
  }).trim();
}

beforeEach(() => {
  mkdirSync(TEMP_REPO, { recursive: true });
  git(["init", "-b", "main"]);
  writeFileSync(join(TEMP_REPO, "file.txt"), "main\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);
});

afterEach(() => {
  rmSync(TEMP_REPO, { recursive: true, force: true });
});

describe("slugify", () => {
  it("converts to lowercase with hyphens", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("replaces special characters with hyphens", () => {
    expect(slugify("fix: bug #123 (urgent!)")).toBe("fix-bug-123-urgent");
  });

  it("strips leading and trailing hyphens", () => {
    expect(slugify("---test---")).toBe("test");
  });

  it("truncates to 50 characters", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBe(50);
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("handles string of only special characters", () => {
    expect(slugify("!@#$%")).toBe("");
  });

  it("collapses multiple consecutive hyphens", () => {
    expect(slugify("foo   bar   baz")).toBe("foo-bar-baz");
  });

  it("handles already-clean branch names", () => {
    expect(slugify("fix-login-bug")).toBe("fix-login-bug");
  });
});

describe("createWorktree", () => {
  it("creates new worktree branches from the resolved base branch", async () => {
    git(["checkout", "-b", "feature/base"]);
    writeFileSync(join(TEMP_REPO, "base-only.txt"), "base\n");
    git(["add", "."]);
    git(["commit", "-m", "base commit"]);

    git(["checkout", "-b", "agent/existing"]);
    writeFileSync(join(TEMP_REPO, "agent-only.txt"), "agent\n");
    git(["add", "."]);
    git(["commit", "-m", "agent commit"]);

    const wt = await createWorktree(TEMP_REPO, "abcdef123456", "follow-up work");

    try {
      expect(wt.baseBranch).toBe("main");
      const branchHead = git(["rev-parse", wt.branchName], TEMP_REPO);
      const mainHead = git(["rev-parse", "main"], TEMP_REPO);
      expect(branchHead).toBe(mainHead);
    } finally {
      await removeWorktree(TEMP_REPO, wt.worktreePath);
      git(["branch", "-D", wt.branchName]);
    }
  });
});

describe("async git helpers", () => {
  it("auto-commits worktree changes without blocking the event loop", async () => {
    const wt = await createWorktree(TEMP_REPO, "abcdef123456", "follow-up work");

    try {
      writeFileSync(join(wt.worktreePath, "file.txt"), "worktree change\n");

      await autoCommitWorktree(wt.worktreePath, "follow-up work", "abcdef123456", wt.branchName);

      expect(git(["log", "-1", "--pretty=%B"], wt.worktreePath)).toBe("agent: follow-up work");
      expect(git(["diff", "--name-only", "main...HEAD"], wt.worktreePath)).toBe("file.txt");
    } finally {
      await removeWorktree(TEMP_REPO, wt.worktreePath);
      git(["branch", "-D", wt.branchName]);
    }
  });

  it("gathers diff stats asynchronously", async () => {
    git(["checkout", "-b", "feature/stats"]);
    writeFileSync(join(TEMP_REPO, "file.txt"), "main\nstats change\n");
    git(["add", "file.txt"]);
    git(["commit", "-m", "stats change"]);

    const stats = await getBranchDiffStatsAsync(TEMP_REPO, "main", "feature/stats");

    expect(stats.filesChanged).toBe(1);
    expect(stats.insertions).toBe(1);
    expect(stats.deletions).toBe(0);
    expect(stats.diffStat).toContain("file.txt");
  });

  it("detects conflicts asynchronously", async () => {
    git(["checkout", "-b", "feature/conflict"]);
    writeFileSync(join(TEMP_REPO, "file.txt"), "feature change\n");
    git(["add", "file.txt"]);
    git(["commit", "-m", "feature change"]);

    git(["checkout", "main"]);
    writeFileSync(join(TEMP_REPO, "file.txt"), "main change\n");
    git(["add", "file.txt"]);
    git(["commit", "-m", "main change"]);

    const conflictInfo = await detectConflictsAsync(TEMP_REPO, "main", "feature/conflict");

    expect(typeof conflictInfo).toBe("string");
    expect(conflictInfo).toContain("CONFLICT");
  });
});
