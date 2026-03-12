import { describe, expect, it } from "bun:test";
import { GIT } from "./git.js";
import { execFileSync } from "node:child_process";

/**
 * Tests for the git binary resolver.
 * Validates that the exported GIT path points to a working git executable.
 */

describe("GIT binary resolution", () => {
  it("exports a non-empty string", () => {
    expect(typeof GIT).toBe("string");
    expect(GIT.length).toBeGreaterThan(0);
  });

  it("points to a working git binary", () => {
    const version = execFileSync(GIT, ["--version"], {
      encoding: "utf-8",
      timeout: 3000,
    });
    expect(version).toContain("git version");
  });

  it("is either 'git' or an absolute path", () => {
    expect(GIT === "git" || GIT.startsWith("/")).toBe(true);
  });
});
