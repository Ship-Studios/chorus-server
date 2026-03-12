import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { slugify, createWorktree, removeWorktree } from "./git-worktree.js";
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

    const wt = createWorktree(TEMP_REPO, "abcdef123456", "follow-up work");

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
