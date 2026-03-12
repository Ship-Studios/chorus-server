import { describe, expect, it } from "bun:test";
import { runGit } from "./run-git.js";
import { join } from "node:path";

/**
 * Tests for the promise-based git runner.
 * Uses real git commands since git is available in the test environment.
 * Runs against the project's own repo for a known-good git directory.
 */

// This package is its own git repo
const REPO_ROOT = join(import.meta.dir, "..");

describe("runGit", () => {
  it("resolves with stdout for successful commands", async () => {
    const output = await runGit(REPO_ROOT, ["rev-parse", "--is-inside-work-tree"]);
    expect(output.trim()).toBe("true");
  });

  it("returns branch name from rev-parse", async () => {
    const branch = await runGit(REPO_ROOT, ["rev-parse", "--abbrev-ref", "HEAD"]);
    expect(branch.trim().length).toBeGreaterThan(0);
  });

  it("rejects for invalid git commands", async () => {
    await expect(runGit(REPO_ROOT, ["not-a-real-command"])).rejects.toThrow();
  });

  it("rejects when cwd does not exist", async () => {
    await expect(
      runGit("/tmp/nonexistent-dir-that-should-not-exist-12345", ["status"])
    ).rejects.toThrow();
  });

  it("handles git log output", async () => {
    const log = await runGit(REPO_ROOT, ["log", "--oneline", "-1"]);
    // Should have at least a commit hash and message
    expect(log.trim().length).toBeGreaterThan(5);
  });

  it("respects custom timeout (does not hang)", async () => {
    // git status should complete well within 1 second
    const output = await runGit(REPO_ROOT, ["status", "--porcelain"], { timeout: 5000 });
    expect(typeof output).toBe("string");
  });

  it("rejects on timeout for artificially slow operations", async () => {
    // Use a very short timeout — even a fast command may not finish in 1ms
    await expect(
      runGit(REPO_ROOT, ["log", "--all", "--oneline"], { timeout: 1 })
    ).rejects.toThrow(/timed out/);
  });

  it("handles diff output with file content", async () => {
    // diff against HEAD with no changes should return empty string
    const diff = await runGit(REPO_ROOT, ["diff", "--stat", "HEAD", "HEAD"]);
    expect(diff).toBe("");
  });
});
