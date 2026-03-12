import { describe, expect, it, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import Fastify from "fastify";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GIT } from "./git.js";
import { parseDiffToFiles, buildStatSummary } from "./diff.js";
import { runGit } from "./run-git.js";
import { createHash } from "node:crypto";

/**
 * Tests for the diff summary route.
 * Tests the endpoint logic with a real git repo and mocked Anthropic SDK.
 */

const TEMP_REPO = join(import.meta.dir, "..", ".test-diff-summary-repo");
const TEMP_WORKTREE = join(import.meta.dir, "..", ".test-diff-summary-worktree");
let app;
let db;
let getSession;
let lookupSessionId;

// Track mock state for the Anthropic client
let mockAnthropicResponse = null;
let mockAnthropicError = null;
let mockCreateCalls = [];

function initDb() {
  db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_dir TEXT NOT NULL,
      worktree_dir TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      model TEXT,
      current_claude_session_id TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE session_aliases (
      claude_session_id TEXT PRIMARY KEY,
      dashboard_session_id TEXT NOT NULL
    );
  `);

  const upsertSession = db.prepare(`
    INSERT INTO sessions (id, project_dir, worktree_dir, status) VALUES ($id, $projectDir, $worktreeDir, $status)
  `);
  getSession = db.prepare(`SELECT * FROM sessions WHERE id = $id`);
  const getAlias = db.prepare(`SELECT dashboard_session_id FROM session_aliases WHERE claude_session_id = $claudeSessionId`);
  lookupSessionId = (id) => {
    const alias = getAlias.get({ $claudeSessionId: id });
    return alias ? alias.dashboard_session_id : id;
  };

  return { upsertSession };
}

function git(args) {
  return execFileSync(GIT, args, {
    cwd: TEMP_REPO,
    encoding: "utf-8",
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_COMMITTER_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_EMAIL: "test@test.com",
    },
  });
}

beforeAll(async () => {
  // Create a temp git repo with a commit
  mkdirSync(TEMP_REPO, { recursive: true });
  git(["init", "-b", "main"]);
  writeFileSync(join(TEMP_REPO, "hello.js"), "const x = 1;\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);

  // Create an unstaged change
  writeFileSync(join(TEMP_REPO, "hello.js"), "const x = 1;\nconst y = 2;\n");
  git(["worktree", "add", "-b", "feature/worktree", TEMP_WORKTREE]);
  writeFileSync(join(TEMP_WORKTREE, "hello.js"), "const x = 1;\nconst worktree = true;\n");

  const { upsertSession } = initDb();

  upsertSession.run({
    $id: "summary-session",
    $projectDir: TEMP_REPO,
    $worktreeDir: null,
    $status: "active",
  });

  upsertSession.run({
    $id: "unknown-dir-session",
    $projectDir: "unknown",
    $worktreeDir: null,
    $status: "active",
  });

  upsertSession.run({
    $id: "missing-dir-session",
    $projectDir: "/tmp/does-not-exist-diff-summary-99999",
    $worktreeDir: null,
    $status: "active",
  });

  upsertSession.run({
    $id: "worktree-summary-session",
    $projectDir: TEMP_REPO,
    $worktreeDir: TEMP_WORKTREE,
    $status: "active",
  });

  app = Fastify();

  // ── Register routes inline (same pattern as routes-diff.test.js) ──

  // Feature status endpoint
  app.get("/api/diff-summary/status", async () => ({
    available: !!process.env.ANTHROPIC_API_KEY,
  }));

  // Summary endpoint
  app.post("/api/sessions/:sessionId/diff/summary", async (req, reply) => {
    if (!process.env.ANTHROPIC_API_KEY) {
      return reply.code(503).send({
        error: "Diff summary unavailable: ANTHROPIC_API_KEY not set",
        available: false,
      });
    }

    const sessionId = lookupSessionId(req.params.sessionId);
    const session = getSession.get({ $id: sessionId });
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const dir = session.worktree_dir || session.project_dir;
    if (!dir || dir === "unknown") {
      return reply.code(400).send({ error: "Session has no known working directory" });
    }

    const { existsSync } = await import("node:fs");
    if (!existsSync(dir)) {
      return reply.code(400).send({ error: `Working directory no longer exists: ${dir}` });
    }

    let diff;
    try {
      diff = await runGit(dir, ["diff", "HEAD", "--no-color", "--unified=3", "--submodule=diff"]);
    } catch {
      try {
        diff = await runGit(dir, ["diff", "--no-color", "--unified=3", "--submodule=diff"]);
      } catch (e) {
        return reply.code(500).send({ error: `Git error: ${e.message}` });
      }
    }

    if (!diff || !diff.trim()) {
      return { summary: null, empty: true };
    }

    // Check cache (we use a local cache Map for tests)
    const hash = createHash("sha256").update(diff).digest("hex");
    if (app._testCache?.has(hash)) {
      const cached = app._testCache.get(hash);
      if (Date.now() - cached.timestamp < 60_000) {
        return { summary: cached.summary, model: cached.model, cached: true };
      }
      app._testCache.delete(hash);
    }

    const files = parseDiffToFiles(diff);
    const stat = buildStatSummary(files);
    const MAX_DIFF_CHARS = 30_000;
    const truncatedDiff = diff.length > MAX_DIFF_CHARS
      ? diff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated]"
      : diff;

    const model = process.env.DIFF_SUMMARY_MODEL ?? "claude-haiku-4-5-20251001";

    // Use mock instead of real Anthropic client
    try {
      mockCreateCalls.push({ model, diff: truncatedDiff, stat });

      if (mockAnthropicError) {
        throw mockAnthropicError;
      }

      const summary = mockAnthropicResponse ?? "• Test summary bullet point";

      if (!app._testCache) app._testCache = new Map();
      app._testCache.set(hash, { summary, model, timestamp: Date.now() });

      return { summary, model, cached: false };
    } catch (err) {
      return reply.code(502).send({
        error: `Summary generation failed: ${err.message}`,
      });
    }
  });

  await app.ready();
});

afterAll(async () => {
  await app?.close();
  execFileSync(GIT, ["worktree", "remove", "--force", TEMP_WORKTREE], {
    cwd: TEMP_REPO,
    stdio: "pipe",
  });
  rmSync(TEMP_REPO, { recursive: true, force: true });
  rmSync(TEMP_WORKTREE, { recursive: true, force: true });
});

beforeEach(() => {
  mockAnthropicResponse = null;
  mockAnthropicError = null;
  mockCreateCalls = [];
  if (app._testCache) app._testCache.clear();
});

// ── GET /api/diff-summary/status ────────────────────────────────────────────

describe("GET /api/diff-summary/status", () => {
  it("returns available: true when ANTHROPIC_API_KEY is set", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const res = await app.inject({ method: "GET", url: "/api/diff-summary/status" });
      expect(res.statusCode).toBe(200);
      expect(res.json().available).toBe(true);
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it("returns available: false when ANTHROPIC_API_KEY is not set", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const res = await app.inject({ method: "GET", url: "/api/diff-summary/status" });
      expect(res.statusCode).toBe(200);
      expect(res.json().available).toBe(false);
    } finally {
      if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });
});

// ── POST /api/sessions/:id/diff/summary ─────────────────────────────────────

describe("POST /api/sessions/:id/diff/summary", () => {
  it("returns 503 when ANTHROPIC_API_KEY is not set", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/summary-session/diff/summary",
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error).toContain("ANTHROPIC_API_KEY not set");
      expect(res.json().available).toBe(false);
    } finally {
      if (origKey !== undefined) process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it("returns 404 for non-existent session", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/nonexistent/diff/summary",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toContain("not found");
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it("returns 400 for session with unknown project dir", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/unknown-dir-session/diff/summary",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("no known working directory");
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it("returns 400 for session with non-existent directory", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/missing-dir-session/diff/summary",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain("no longer exists");
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it("returns summary for a session with uncommitted changes", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockAnthropicResponse = "• Added a new variable `y` to hello.js";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/summary-session/diff/summary",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.summary).toBe("• Added a new variable `y` to hello.js");
      expect(body.model).toBe("claude-haiku-4-5-20251001");
      expect(body.cached).toBe(false);
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it("returns cached summary on second call with same diff", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockAnthropicResponse = "• Cached bullet point";
    try {
      // First call — generates summary
      await app.inject({
        method: "POST",
        url: "/api/sessions/summary-session/diff/summary",
      });
      expect(mockCreateCalls).toHaveLength(1);

      // Second call — should use cache
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/summary-session/diff/summary",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.summary).toBe("• Cached bullet point");
      expect(body.cached).toBe(true);
      // Should not have made a second API call
      expect(mockCreateCalls).toHaveLength(1);
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it("returns 502 when Anthropic API fails", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockAnthropicError = new Error("Rate limit exceeded");
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/summary-session/diff/summary",
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toContain("Rate limit exceeded");
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it("uses DIFF_SUMMARY_MODEL env var when set", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    const origModel = process.env.DIFF_SUMMARY_MODEL;
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.DIFF_SUMMARY_MODEL = "claude-sonnet-4-5-20250514";
    mockAnthropicResponse = "• Custom model summary";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/summary-session/diff/summary",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.model).toBe("claude-sonnet-4-5-20250514");
      expect(mockCreateCalls[0].model).toBe("claude-sonnet-4-5-20250514");
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
      if (origModel === undefined) delete process.env.DIFF_SUMMARY_MODEL;
      else process.env.DIFF_SUMMARY_MODEL = origModel;
    }
  });

  it("returns empty result when working tree is clean", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";

    // Make the tree clean
    execFileSync(GIT, ["checkout", "--", "hello.js"], { cwd: TEMP_REPO, stdio: "pipe" });

    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/summary-session/diff/summary",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.summary).toBeNull();
      expect(body.empty).toBe(true);
      // Should not call the LLM
      expect(mockCreateCalls).toHaveLength(0);
    } finally {
      // Restore the change
      writeFileSync(join(TEMP_REPO, "hello.js"), "const x = 1;\nconst y = 2;\n");
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it("passes stat and diff to the LLM call", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockAnthropicResponse = "• Test";
    try {
      await app.inject({
        method: "POST",
        url: "/api/sessions/summary-session/diff/summary",
      });
      expect(mockCreateCalls).toHaveLength(1);
      expect(mockCreateCalls[0].diff).toContain("const y = 2");
      expect(mockCreateCalls[0].stat).toContain("hello.js");
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });

  it("prefers worktree_dir over project_dir when present", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockAnthropicResponse = "• Test";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/worktree-summary-session/diff/summary",
      });
      expect(res.statusCode).toBe(200);
      expect(mockCreateCalls).toHaveLength(1);
      expect(mockCreateCalls[0].diff).toContain("const worktree = true");
      expect(mockCreateCalls[0].diff).not.toContain("const y = 2");
    } finally {
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });
});

// ── Cache behavior ──────────────────────────────────────────────────────────

describe("cache behavior", () => {
  it("cache is invalidated when diff changes", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockAnthropicResponse = "• First summary";
    try {
      // First call with current diff
      await app.inject({
        method: "POST",
        url: "/api/sessions/summary-session/diff/summary",
      });
      expect(mockCreateCalls).toHaveLength(1);

      // Change the file
      writeFileSync(join(TEMP_REPO, "hello.js"), "const x = 1;\nconst y = 2;\nconst z = 3;\n");

      mockAnthropicResponse = "• Second summary with z";

      // Second call — diff changed, should not use cache
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/summary-session/diff/summary",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().summary).toBe("• Second summary with z");
      expect(res.json().cached).toBe(false);
      expect(mockCreateCalls).toHaveLength(2);
    } finally {
      // Restore
      writeFileSync(join(TEMP_REPO, "hello.js"), "const x = 1;\nconst y = 2;\n");
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });
});

// ── Diff truncation ─────────────────────────────────────────────────────────

describe("diff truncation", () => {
  it("truncates very large diffs", async () => {
    const origKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    mockAnthropicResponse = "• Large diff summary";

    // Create a very large file change
    const largeContent = "const x = 1;\n" + "// line\n".repeat(5000);
    writeFileSync(join(TEMP_REPO, "hello.js"), largeContent);

    try {
      await app.inject({
        method: "POST",
        url: "/api/sessions/summary-session/diff/summary",
      });

      expect(mockCreateCalls).toHaveLength(1);
      // The diff sent to the LLM should be truncated
      expect(mockCreateCalls[0].diff.length).toBeLessThanOrEqual(30_000 + 20); // +20 for "[diff truncated]" suffix
    } finally {
      writeFileSync(join(TEMP_REPO, "hello.js"), "const x = 1;\nconst y = 2;\n");
      if (origKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = origKey;
    }
  });
});
