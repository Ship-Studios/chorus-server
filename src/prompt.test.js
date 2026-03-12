import { describe, expect, it, afterEach } from "bun:test";
import { cancelPrompt, isPromptActive, cancelSwarmAgent, getActiveSwarmAgents } from "./prompt.js";

/**
 * Unit tests for prompt.js — testing the state management functions.
 * We can't easily test sendPrompt/spawnSwarmAgent without spawning real
 * processes, so we focus on the cancellation and query functions.
 */

describe("cancelPrompt", () => {
  it("returns false when no active prompt exists", () => {
    expect(cancelPrompt("nonexistent-session")).toBe(false);
  });
});

describe("isPromptActive", () => {
  it("returns false for unknown session", () => {
    expect(isPromptActive("no-such-session")).toBe(false);
  });
});

describe("cancelSwarmAgent", () => {
  it("returns false for non-existent agent", () => {
    expect(cancelSwarmAgent("nonexistent-agent")).toBe(false);
  });
});

describe("getActiveSwarmAgents", () => {
  it("returns empty array when no agents are active", () => {
    expect(getActiveSwarmAgents("any-session")).toEqual([]);
  });

  it("returns empty array when called without sessionId filter", () => {
    expect(getActiveSwarmAgents()).toEqual([]);
  });
});
