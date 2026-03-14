import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import Fastify from "fastify";
import { invalidateDiffCache } from "./diff-cache.js";
import { createDiffRoutes } from "./routes/diff.js";

const sessions = new Map();
let app;
let runGitCalls;
let buildStatCalls;
let parseDiffCalls;

function createDiffBody(label = "cached") {
  return [
    `diff --git a/${label}.js b/${label}.js`,
    `--- a/${label}.js`,
    `+++ b/${label}.js`,
    "@@ -1 +1 @@",
    `-const value = "${label}-old";`,
    `+const value = "${label}-new";`,
    "",
  ].join("\n");
}

beforeEach(async () => {
  invalidateDiffCache();
  sessions.clear();
  runGitCalls = [];
  buildStatCalls = [];
  parseDiffCalls = [];

  sessions.set("session-1", {
    id: "session-1",
    project_dir: "/repo",
    worktree_dir: null,
  });
  sessions.set("session-2", {
    id: "session-2",
    project_dir: "/other-repo",
    worktree_dir: null,
  });

  app = Fastify();
  await app.register(createDiffRoutes({
    buildStatSummary(files) {
      buildStatCalls.push(files);
      return `${files.length} file changed`;
    },
    existsSync() {
      return true;
    },
    getSession: {
      get({ $id }) {
        return sessions.get($id) ?? null;
      },
    },
    lookupSessionId(sessionId) {
      return sessionId;
    },
    parseDiffToFiles(diff) {
      parseDiffCalls.push(diff);
      const label = diff.includes("other-repo") ? "other-repo" : "cached";
      return [{
        oldFileName: `${label}.js`,
        newFileName: `${label}.js`,
        fileLang: "javascript",
        hunks: [diff],
        additions: 1,
        deletions: 1,
      }];
    },
    async runGit(dir, args) {
      runGitCalls.push({ dir, args });
      if (args[0] === "rev-parse") {
        return dir === "/other-repo" ? "feature/other\n" : "main\n";
      }
      return dir === "/other-repo" ? createDiffBody("other-repo") : createDiffBody("cached");
    },
  }));
  await app.ready();
});

afterEach(async () => {
  invalidateDiffCache();
  sessions.clear();
  await app.close();
});

describe("createDiffRoutes cache", () => {
  it("reuses computed diffs across sequential requests", async () => {
    const first = await app.inject({
      method: "GET",
      url: "/api/sessions/session-1/diff",
    });
    const second = await app.inject({
      method: "GET",
      url: "/api/sessions/session-1/diff",
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(runGitCalls).toEqual([
      { dir: "/repo", args: ["diff", "HEAD", "--no-color", "--unified=5", "--submodule=diff"] },
      { dir: "/repo", args: ["rev-parse", "--abbrev-ref", "HEAD"] },
    ]);
  });

  it("serves 304 responses from cached diff state", async () => {
    const first = await app.inject({
      method: "GET",
      url: "/api/sessions/session-1/diff",
    });

    const second = await app.inject({
      method: "GET",
      url: "/api/sessions/session-1/diff",
      headers: {
        "if-none-match": first.headers.etag,
      },
    });

    expect(second.statusCode).toBe(304);
    expect(runGitCalls).toEqual([
      { dir: "/repo", args: ["diff", "HEAD", "--no-color", "--unified=5", "--submodule=diff"] },
      { dir: "/repo", args: ["rev-parse", "--abbrev-ref", "HEAD"] },
    ]);
  });

  it("recomputes after explicit cache invalidation", async () => {
    await app.inject({
      method: "GET",
      url: "/api/sessions/session-1/diff",
    });

    invalidateDiffCache();

    await app.inject({
      method: "GET",
      url: "/api/sessions/session-1/diff",
    });

    expect(runGitCalls).toEqual([
      { dir: "/repo", args: ["diff", "HEAD", "--no-color", "--unified=5", "--submodule=diff"] },
      { dir: "/repo", args: ["rev-parse", "--abbrev-ref", "HEAD"] },
      { dir: "/repo", args: ["diff", "HEAD", "--no-color", "--unified=5", "--submodule=diff"] },
      { dir: "/repo", args: ["rev-parse", "--abbrev-ref", "HEAD"] },
    ]);
  });

  it("returns 304 after invalidation without re-parsing the diff", async () => {
    const first = await app.inject({
      method: "GET",
      url: "/api/sessions/session-1/diff",
    });

    invalidateDiffCache("/repo");
    runGitCalls = [];
    buildStatCalls = [];
    parseDiffCalls = [];

    const second = await app.inject({
      method: "GET",
      url: "/api/sessions/session-1/diff",
      headers: {
        "if-none-match": first.headers.etag,
      },
    });

    expect(second.statusCode).toBe(304);
    expect(parseDiffCalls).toHaveLength(0);
    expect(buildStatCalls).toHaveLength(0);
    expect(runGitCalls).toEqual([
      { dir: "/repo", args: ["diff", "HEAD", "--no-color", "--unified=5", "--submodule=diff"] },
    ]);
  });

  it("invalidates only the targeted directory cache entry", async () => {
    await app.inject({
      method: "GET",
      url: "/api/sessions/session-1/diff",
    });
    await app.inject({
      method: "GET",
      url: "/api/sessions/session-2/diff",
    });

    runGitCalls = [];
    invalidateDiffCache("/repo");

    await app.inject({
      method: "GET",
      url: "/api/sessions/session-2/diff",
    });
    await app.inject({
      method: "GET",
      url: "/api/sessions/session-1/diff",
    });

    expect(runGitCalls).toEqual([
      { dir: "/repo", args: ["diff", "HEAD", "--no-color", "--unified=5", "--submodule=diff"] },
      { dir: "/repo", args: ["rev-parse", "--abbrev-ref", "HEAD"] },
    ]);
  });
});
