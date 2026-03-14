import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import Fastify from "fastify";
import { clearSummaryState, createDiffSummaryRoutes } from "./routes/diff-summary.js";

const sessions = new Map();
const DIFF = [
  "diff --git a/app.js b/app.js",
  "--- a/app.js",
  "+++ b/app.js",
  "@@ -1 +1 @@",
  "-const before = true;",
  "+const after = true;",
  "",
].join("\n");

let app;
let buildStatCalls;
let runGitCalls;
let summarizeCalls;
let releaseSummary;
let summaryStarted;
let markSummaryStarted;

beforeEach(async () => {
  clearSummaryState();
  sessions.clear();
  buildStatCalls = 0;
  runGitCalls = 0;
  summarizeCalls = 0;
  releaseSummary = null;
  summaryStarted = new Promise((resolve) => {
    markSummaryStarted = resolve;
  });
  process.env.ANTHROPIC_API_KEY = "test-key";

  sessions.set("session-1", {
    id: "session-1",
    project_dir: "/repo",
    worktree_dir: null,
  });

  app = Fastify();
  await app.register(createDiffSummaryRoutes({
    Anthropic: class MockAnthropic {
      constructor() {
        this.messages = { create: async () => ({ content: [{ text: "unused" }] }) };
      }
    },
    buildStatFromShortstat: async () => {
      buildStatCalls += 1;
      return "1 file changed, 1 insertion(+), 1 deletion(-)";
    },
    existsSync() {
      return true;
    },
    getAnthropicFetchOptions() {
      return {};
    },
    getSession: {
      get({ $id }) {
        return sessions.get($id) ?? null;
      },
    },
    lookupSessionId(sessionId) {
      return sessionId;
    },
    async runGit() {
      runGitCalls += 1;
      return DIFF;
    },
    summarizeDiff: async () => {
      summarizeCalls += 1;
      markSummaryStarted();
      await new Promise((resolve) => {
        releaseSummary = resolve;
      });
      return {
        summary: "Updated app.js",
        model: "test-model",
      };
    },
  }));
  await app.ready();
});

afterEach(async () => {
  clearSummaryState();
  sessions.clear();
  delete process.env.ANTHROPIC_API_KEY;
  await app.close();
});

describe("createDiffSummaryRoutes inflight dedupe", () => {
  it("coalesces concurrent summary generation for the same diff", async () => {
    const first = app.inject({
      method: "POST",
      url: "/api/sessions/session-1/diff/summary",
    });
    const second = app.inject({
      method: "POST",
      url: "/api/sessions/session-1/diff/summary",
    });

    await summaryStarted;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(summarizeCalls).toBe(1);
    expect(buildStatCalls).toBe(1);

    releaseSummary();

    const [firstRes, secondRes] = await Promise.all([first, second]);
    expect(firstRes.statusCode).toBe(200);
    expect(secondRes.statusCode).toBe(200);
    expect(firstRes.json()).toEqual({ summary: "Updated app.js", model: "test-model", cached: false });
    expect(secondRes.json()).toEqual({ summary: "Updated app.js", model: "test-model", cached: false });
    expect(runGitCalls).toBe(2);
  });
});
