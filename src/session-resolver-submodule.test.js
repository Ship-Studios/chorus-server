import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GIT } from "./git.js";

/**
 * Tests that `git rev-parse --show-superproject-working-tree` correctly
 * detects submodules — validating the fix in resolveGitRoot().
 *
 * Creates a temp parent repo with a submodule, then verifies the actual git
 * behavior that the production code relies on:
 *
 * 1. Inside the submodule working tree, `git worktree list` returns the gitdir
 *    path (`.git/modules/.../child`) — NOT the working tree path, NOT the parent.
 * 2. `git rev-parse --show-superproject-working-tree` called from the submodule
 *    WORKING TREE returns the parent repo root.
 * 3. `git rev-parse --show-superproject-working-tree` called from the gitdir
 *    (what worktree list returns) returns empty — it must be called from the
 *    working tree.
 * 4. For a normal (non-submodule) repo, `--show-superproject-working-tree` returns empty.
 */

const TEMP_DIR = join(import.meta.dir, "..", ".test-submodule-detection");
const PARENT_REPO = join(TEMP_DIR, "parent-repo");
const CHILD_REPO = join(TEMP_DIR, "child-repo");

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test",
  GIT_COMMITTER_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_EMAIL: "test@test.com",
  // Allow file:// protocol for local submodule add (blocked by default since git 2.38.1)
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "protocol.file.allow",
  GIT_CONFIG_VALUE_0: "always",
};

function git(args, cwd) {
  return execFileSync(GIT, args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    env: gitEnv,
  }).trim();
}

beforeAll(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
  mkdirSync(TEMP_DIR, { recursive: true });

  // Create child repo (will become the submodule)
  mkdirSync(CHILD_REPO, { recursive: true });
  git(["init", "-b", "main"], CHILD_REPO);
  writeFileSync(join(CHILD_REPO, "lib.js"), "export const lib = 1;\n");
  git(["add", "."], CHILD_REPO);
  git(["commit", "-m", "init child"], CHILD_REPO);

  // Create parent repo
  mkdirSync(PARENT_REPO, { recursive: true });
  git(["init", "-b", "main"], PARENT_REPO);
  writeFileSync(join(PARENT_REPO, "app.js"), "import { lib } from './packages/child/lib.js';\n");
  git(["add", "."], PARENT_REPO);
  git(["commit", "-m", "init parent"], PARENT_REPO);

  // Add child as submodule
  git(["submodule", "add", CHILD_REPO, "packages/child"], PARENT_REPO);
  git(["commit", "-m", "add submodule"], PARENT_REPO);
});

afterAll(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

describe("submodule detection via git rev-parse", () => {
  const submodulePath = join(PARENT_REPO, "packages", "child");
  // When a submodule is embedded via `submodule add`, git stores the submodule's
  // git database inside the parent's .git/modules/ directory. `git worktree list`
  // run inside the submodule working tree returns that gitdir path — NOT the
  // working tree path itself. This is the path resolveGitRoot() then passes to
  // `--show-superproject-working-tree`.
  const submoduleGitDir = join(PARENT_REPO, ".git", "modules", "packages", "child");

  it("git worktree list inside submodule working tree returns the gitdir path", () => {
    const output = git(["worktree", "list", "--porcelain"], submodulePath);
    const match = output.match(/^worktree (.+)$/m);
    expect(match).toBeTruthy();
    // The path returned is the gitdir inside .git/modules/, NOT the working tree
    expect(match[1]).toBe(submoduleGitDir);
    expect(match[1]).not.toBe(submodulePath);
    expect(match[1]).not.toBe(PARENT_REPO);
  });

  it("git rev-parse --show-superproject-working-tree from submodule WORKING TREE returns parent", () => {
    // This is the key: must be called from the working tree path, not the gitdir
    const superproject = git(
      ["rev-parse", "--show-superproject-working-tree"],
      submodulePath,
    );
    expect(superproject).toBe(PARENT_REPO);
  });

  it("git rev-parse --show-superproject-working-tree from submodule GITDIR returns empty", () => {
    // Called from the gitdir path returned by worktree list — returns empty
    // This illustrates that resolveGitRoot must call --show-superproject from
    // the original dir argument, not from the root returned by worktree list
    const superproject = git(
      ["rev-parse", "--show-superproject-working-tree"],
      submoduleGitDir,
    );
    expect(superproject).toBe("");
  });

  it("git rev-parse --show-superproject-working-tree returns empty for normal repo", () => {
    const superproject = git(
      ["rev-parse", "--show-superproject-working-tree"],
      PARENT_REPO,
    );
    expect(superproject).toBe("");
  });

  it("correct fix: check superproject on original dir before worktree list resolution", () => {
    // The correct two-step resolution for submodule detection:
    // 1. Check --show-superproject-working-tree from the original dir (working tree)
    const superproject = git(
      ["rev-parse", "--show-superproject-working-tree"],
      submodulePath,
    );
    // 2. If non-empty, use the superproject as the git root
    const root = superproject || submodulePath;
    // Result is the parent repo root
    expect(root).toBe(PARENT_REPO);
  });

  it("git worktree list from parent repo returns parent root", () => {
    const output = git(["worktree", "list", "--porcelain"], PARENT_REPO);
    const match = output.match(/^worktree (.+)$/m);
    expect(match[1]).toBe(PARENT_REPO);
  });
});
