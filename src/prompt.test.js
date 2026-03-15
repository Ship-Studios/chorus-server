import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
  cancelPrompt,
  isPromptActive,
  getPromptSessionId,
  cancelSwarmAgent,
  getActiveSwarmAgents,
  getCurrentBranch,
  getBranchDiffStats,
  detectConflicts,
} from "./prompt-sdk.js";

/**
 * Tests for prompt.js — state management functions and exported git helpers.
 * Process-spawning functions (sendPrompt, spawnSwarmAgent) are not tested
 * here since they require a real `claude` binary.
 */

const REPO_ROOT = join(import.meta.dir, "..");

// ─── In-memory state management ────────────────────────────────────────────

describe("cancelPrompt", () => {
  it("returns false when no active prompt exists", () => {
    expect(cancelPrompt("nonexistent-session")).toBe(false);
  });

  it("returns false for empty string session id", () => {
    expect(cancelPrompt("")).toBe(false);
  });
});

describe("isPromptActive", () => {
  it("returns false for unknown session", () => {
    expect(isPromptActive("no-such-session")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isPromptActive("")).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isPromptActive(undefined)).toBe(false);
  });
});

describe("getPromptSessionId", () => {
  it("returns null for unknown session", () => {
    expect(getPromptSessionId("nonexistent")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(getPromptSessionId("")).toBeNull();
  });
});

describe("cancelSwarmAgent", () => {
  it("returns { cancelled: false } for non-existent agent", () => {
    expect(cancelSwarmAgent("nonexistent-agent")).toEqual({ cancelled: false, sessionId: null });
  });

  it("returns { cancelled: false } for empty id", () => {
    expect(cancelSwarmAgent("")).toEqual({ cancelled: false, sessionId: null });
  });
});

describe("getActiveSwarmAgents", () => {
  it("returns empty array when no agents are active", () => {
    expect(getActiveSwarmAgents("any-session")).toEqual([]);
  });

  it("returns empty array when called without sessionId filter", () => {
    expect(getActiveSwarmAgents()).toEqual([]);
  });

  it("returns empty array for undefined sessionId", () => {
    expect(getActiveSwarmAgents(undefined)).toEqual([]);
  });
});

// ─── Git helper functions ──────────────────────────────────────────────────

describe("getCurrentBranch", () => {
  it("returns the current branch name for a valid repo", () => {
    const branch = getCurrentBranch(REPO_ROOT);
    expect(typeof branch).toBe("string");
    expect(branch.length).toBeGreaterThan(0);
    // Should not contain newlines
    expect(branch).not.toContain("\n");
  });

  it("falls back to 'main' for non-repo directory", () => {
    const branch = getCurrentBranch("/tmp");
    expect(branch).toBe("main");
  });

  it("falls back to 'main' for nonexistent directory", () => {
    const branch = getCurrentBranch("/nonexistent-dir-xyz-12345");
    expect(branch).toBe("main");
  });
});

describe("getBranchDiffStats", () => {
  it("returns zero stats when comparing a branch to itself", () => {
    const branch = getCurrentBranch(REPO_ROOT);
    const stats = getBranchDiffStats(REPO_ROOT, branch, branch);
    expect(stats.filesChanged).toBe(0);
    expect(stats.insertions).toBe(0);
    expect(stats.deletions).toBe(0);
    expect(stats.diffStat).toBe("");
  });

  it("returns zero stats for invalid repo directory", () => {
    const stats = getBranchDiffStats("/tmp", "main", "main");
    expect(stats.filesChanged).toBe(0);
    expect(stats.insertions).toBe(0);
    expect(stats.deletions).toBe(0);
    expect(stats.diffStat).toBe("");
  });

  it("returns zero stats for nonexistent branches", () => {
    const stats = getBranchDiffStats(REPO_ROOT, "nonexistent-branch-xyz", "another-fake-branch");
    expect(stats.filesChanged).toBe(0);
    expect(stats.insertions).toBe(0);
    expect(stats.deletions).toBe(0);
  });

  it("returns an object with expected keys", () => {
    const branch = getCurrentBranch(REPO_ROOT);
    const stats = getBranchDiffStats(REPO_ROOT, branch, branch);
    expect(stats).toHaveProperty("filesChanged");
    expect(stats).toHaveProperty("insertions");
    expect(stats).toHaveProperty("deletions");
    expect(stats).toHaveProperty("diffStat");
  });
});

describe("detectConflicts", () => {
  it("returns null (no conflicts) when comparing a branch to itself", () => {
    const branch = getCurrentBranch(REPO_ROOT);
    const result = detectConflicts(REPO_ROOT, branch, branch);
    expect(result).toBeNull();
  });

  it("returns conflict info string for nonexistent branches", () => {
    // nonexistent branches cause git merge-tree to fail → returns conflict string
    const result = detectConflicts(REPO_ROOT, "nonexistent-a", "nonexistent-b");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns string or null (never throws)", () => {
    // Even with bad inputs, detectConflicts catches errors
    const result = detectConflicts("/nonexistent-dir", "main", "main");
    // Should be a string (error case) or null, never undefined
    expect(result === null || typeof result === "string").toBe(true);
  });
});
