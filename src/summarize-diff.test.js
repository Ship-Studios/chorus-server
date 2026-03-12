import { describe, expect, it } from "bun:test";
import {
  SYSTEM_PROMPT,
  DEFAULT_MODEL,
  MAX_DIFF_CHARS,
  buildUserPrompt,
  truncateDiff,
} from "./summarize-diff.js";

describe("summarize-diff constants", () => {
  it("exports a non-empty system prompt", () => {
    expect(SYSTEM_PROMPT.length).toBeGreaterThan(0);
    expect(SYSTEM_PROMPT).toContain("dashboard");
    expect(SYSTEM_PROMPT).toContain("120 words");
  });

  it("exports a default model", () => {
    expect(DEFAULT_MODEL).toContain("claude");
  });

  it("MAX_DIFF_CHARS is 30000", () => {
    expect(MAX_DIFF_CHARS).toBe(30_000);
  });
});

describe("buildUserPrompt", () => {
  it("includes stat and diff in the output", () => {
    const prompt = buildUserPrompt("1 file changed", "diff content here");
    expect(prompt).toContain("<stat>\n1 file changed\n</stat>");
    expect(prompt).toContain("<diff>\ndiff content here\n</diff>");
  });

  it("includes the instruction text", () => {
    const prompt = buildUserPrompt("", "");
    expect(prompt).toContain("Summarize this git diff");
    expect(prompt).toContain("one-sentence overview");
    expect(prompt).toContain("functional impact");
  });
});

describe("truncateDiff", () => {
  it("returns short diffs unchanged", () => {
    const short = "diff --git a/foo b/foo\n+hello";
    expect(truncateDiff(short)).toBe(short);
  });

  it("truncates diffs exceeding MAX_DIFF_CHARS", () => {
    const long = "x".repeat(MAX_DIFF_CHARS + 5000);
    const result = truncateDiff(long);
    expect(result.length).toBeLessThan(long.length);
    expect(result).toContain("[diff truncated]");
    expect(result.length).toBe(MAX_DIFF_CHARS + "\n\n[diff truncated]".length);
  });

  it("does not truncate a diff exactly at the limit", () => {
    const exact = "y".repeat(MAX_DIFF_CHARS);
    expect(truncateDiff(exact)).toBe(exact);
  });
});
