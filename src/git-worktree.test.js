import { describe, expect, it } from "bun:test";
import { slugify } from "./git-worktree.js";

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
