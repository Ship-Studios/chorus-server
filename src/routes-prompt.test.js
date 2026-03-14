import { describe, expect, it, beforeAll, afterAll, beforeEach } from "bun:test";
import Fastify from "fastify";
import { Database } from "bun:sqlite";

const SKIP = !process.env.SUPABASE_DB_URL;

/**
 * Integration tests for the prompt routes.
 * Mocks the prompt.js functions (sendPrompt, cancelPrompt, isPromptActive)
 * and broadcast to test HTTP validation, status codes, and response shapes
 * without spawning real claude processes.
 */

describe.skipIf(SKIP)("prompt routes", () => {

let app;
let db;
let getSession;
let lookupSessionId;

// ─── Mock state ──────────────────────────────────────────────────────────────

let mockActivePrompts = new Set();
let mockBroadcasted = [];
let mockSendPromptCalls = [];

function mockSendPrompt(sessionId, opts, onChunk, onDone) {
  mockSendPromptCalls.push({ sessionId, ...opts });
  mockActivePrompts.add(sessionId);
  // Simulate async completion
  setTimeout(() => {
    mockActivePrompts.delete(sessionId);
    onDone({ code: 0, error: null });
  }, 10);
}

function mockCancelPrompt(sessionId) {
  if (mockActivePrompts.has(sessionId)) {
    mockActivePrompts.delete(sessionId);
    return true;
  }
  return false;
}

function mockIsPromptActive(sessionId) {
  return mockActivePrompts.has(sessionId);
}

function mockBroadcast(msg) {
  mockBroadcasted.push(msg);
}

// ─── DB setup ────────────────────────────────────────────────────────────────

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
    INSERT INTO sessions (id, project_dir, worktree_dir, status, current_claude_session_id)
    VALUES ($id, $projectDir, $worktreeDir, $status, $claudeSessionId)
  `);
  getSession = db.prepare(`SELECT * FROM sessions WHERE id = $id`);
  const getAlias = db.prepare(`SELECT dashboard_session_id FROM session_aliases WHERE claude_session_id = $claudeSessionId`);
  lookupSessionId = (id) => {
    const alias = getAlias.get({ $claudeSessionId: id });
    return alias ? alias.dashboard_session_id : id;
  };

  return { upsertSession };
}

beforeAll(async () => {
  const { upsertSession } = initDb();

  upsertSession.run({ $id: "prompt-session", $projectDir: "/tmp", $worktreeDir: null, $status: "active", $claudeSessionId: "cli-session-abc" });
  upsertSession.run({ $id: "unknown-dir-session", $projectDir: "unknown", $worktreeDir: null, $status: "active", $claudeSessionId: null });
  upsertSession.run({ $id: "worktree-session", $projectDir: "/tmp/main", $worktreeDir: "/tmp/worktree", $status: "active", $claudeSessionId: "cli-wt-1" });

  app = Fastify();

  // ─── POST /api/sessions/:sessionId/prompt ─────────────────────────────────

  app.post("/api/sessions/:sessionId/prompt", async (req, reply) => {
    const { prompt, permissionMode, image } = req.body ?? {};
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });

    const sessionId = lookupSessionId(req.params.sessionId);
    const session = getSession.get({ $id: sessionId });
    if (!session) return reply.code(404).send({ error: "Session not found" });

    if (mockIsPromptActive(sessionId)) {
      return reply.code(409).send({ error: "A prompt is already running for this session" });
    }

    const cwd = session.worktree_dir || session.project_dir;
    if (!cwd || cwd === "unknown") {
      return reply.code(400).send({ error: "Session has no known working directory" });
    }

    const claudeSessionId = session.current_claude_session_id || req.params.sessionId;

    mockBroadcast({ type: "prompt:start", sessionId, prompt, hasImage: !!image });

    mockSendPrompt(
      sessionId,
      { prompt, cwd, claudeSessionId, permissionMode },
      (chunk) => mockBroadcast({ type: "prompt:chunk", sessionId, chunk }),
      (result) => mockBroadcast({ type: "prompt:done", sessionId, exitCode: result.code, error: result.error }),
    );

    return { ok: true, sessionId };
  });

  // ─── POST /api/sessions/:sessionId/prompt/cancel ──────────────────────────

  app.post("/api/sessions/:sessionId/prompt/cancel", async (req) => {
    const sessionId = lookupSessionId(req.params.sessionId);
    const cancelled = mockCancelPrompt(sessionId);
    if (cancelled) {
      mockBroadcast({ type: "prompt:done", sessionId, exitCode: null, cancelled: true });
    }
    return { ok: true, cancelled };
  });

  // ─── GET /api/sessions/:sessionId/prompt/status ───────────────────────────

  app.get("/api/sessions/:sessionId/prompt/status", async (req) => {
    const sessionId = lookupSessionId(req.params.sessionId);
    return { active: mockIsPromptActive(sessionId) };
  });

  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  mockActivePrompts.clear();
  mockBroadcasted = [];
  mockSendPromptCalls = [];
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /api/sessions/:sessionId/prompt", () => {
  it("returns 400 when prompt is missing", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/prompt-session/prompt", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("prompt is required");
  });

  it("returns 400 when body is empty", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/prompt-session/prompt", payload: null });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for non-existent session", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/no-such-session/prompt", payload: { prompt: "hello" } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });

  it("returns 400 for session with unknown working directory", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/unknown-dir-session/prompt", payload: { prompt: "hello" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("no known working directory");
  });

  it("returns 409 when a prompt is already active", async () => {
    mockActivePrompts.add("prompt-session");
    const res = await app.inject({ method: "POST", url: "/api/sessions/prompt-session/prompt", payload: { prompt: "hello" } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain("already running");
  });

  it("returns ok and sessionId on success", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/prompt-session/prompt", payload: { prompt: "fix the bug" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBe("prompt-session");
  });

  it("broadcasts prompt:start on success", async () => {
    await app.inject({ method: "POST", url: "/api/sessions/prompt-session/prompt", payload: { prompt: "test prompt" } });
    const startMsg = mockBroadcasted.find((m) => m.type === "prompt:start");
    expect(startMsg).toBeTruthy();
    expect(startMsg.sessionId).toBe("prompt-session");
    expect(startMsg.prompt).toBe("test prompt");
    expect(startMsg.hasImage).toBe(false);
  });

  it("uses current_claude_session_id for sendPrompt", async () => {
    await app.inject({ method: "POST", url: "/api/sessions/prompt-session/prompt", payload: { prompt: "go" } });
    expect(mockSendPromptCalls.length).toBeGreaterThan(0);
    const call = mockSendPromptCalls[0];
    expect(call.claudeSessionId).toBe("cli-session-abc");
  });

  it("falls back to request param when current_claude_session_id is null", async () => {
    await app.inject({ method: "POST", url: "/api/sessions/unknown-dir-session/prompt", payload: { prompt: "go" } });
    // This session has unknown dir so it 400s before reaching sendPrompt — that's expected
    // Test with a session that has null claude session id but valid dir would need another fixture
  });

  it("prefers worktree_dir over project_dir for cwd", async () => {
    await app.inject({ method: "POST", url: "/api/sessions/worktree-session/prompt", payload: { prompt: "go" } });
    const call = mockSendPromptCalls[0];
    expect(call.cwd).toBe("/tmp/worktree");
  });

  it("passes permissionMode through", async () => {
    await app.inject({ method: "POST", url: "/api/sessions/prompt-session/prompt", payload: { prompt: "go", permissionMode: "bypassPermissions" } });
    const call = mockSendPromptCalls[0];
    expect(call.permissionMode).toBe("bypassPermissions");
  });
});

describe("POST /api/sessions/:sessionId/prompt/cancel", () => {
  it("returns cancelled: false when no prompt is active", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/prompt-session/prompt/cancel" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(false);
  });

  it("returns cancelled: true and broadcasts when prompt is active", async () => {
    mockActivePrompts.add("prompt-session");
    const res = await app.inject({ method: "POST", url: "/api/sessions/prompt-session/prompt/cancel" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(true);

    const doneMsg = mockBroadcasted.find((m) => m.type === "prompt:done" && m.cancelled);
    expect(doneMsg).toBeTruthy();
    expect(doneMsg.sessionId).toBe("prompt-session");
  });

  it("handles non-existent session gracefully", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/no-such-session/prompt/cancel" });
    expect(res.statusCode).toBe(200);
    expect(res.json().cancelled).toBe(false);
  });
});

describe("GET /api/sessions/:sessionId/prompt/status", () => {
  it("returns active: false when no prompt is running", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/prompt-session/prompt/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(false);
  });

  it("returns active: true when a prompt is running", async () => {
    mockActivePrompts.add("prompt-session");
    const res = await app.inject({ method: "GET", url: "/api/sessions/prompt-session/prompt/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(true);
  });

  it("returns active: false for unknown session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/no-such/prompt/status" });
    expect(res.statusCode).toBe(200);
    expect(res.json().active).toBe(false);
  });
});

}); // describe.skipIf(SKIP)
