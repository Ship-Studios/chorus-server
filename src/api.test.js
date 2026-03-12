import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { Database } from "bun:sqlite";

/**
 * Integration tests for the server API.
 * Uses an in-memory SQLite database and builds a minimal Fastify app
 * that mirrors the real server's routes.
 */

// ─── In-memory DB setup ─────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(":memory:");

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_dir TEXT NOT NULL,
      worktree_dir TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      model TEXT,
      current_claude_session_id TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      type TEXT NOT NULL,
      tool_name TEXT,
      file_path TEXT,
      summary TEXT,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

    CREATE TABLE IF NOT EXISTS session_aliases (
      claude_session_id TEXT PRIMARY KEY,
      dashboard_session_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      event_id INTEGER REFERENCES events(id),
      description TEXT,
      agent_type TEXT,
      prompt TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);

    CREATE TABLE IF NOT EXISTS worktrees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      branch_name TEXT NOT NULL,
      base_branch TEXT NOT NULL DEFAULT 'main',
      description TEXT,
      agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      files_changed INTEGER DEFAULT 0,
      insertions INTEGER DEFAULT 0,
      deletions INTEGER DEFAULT 0,
      diff_stat TEXT,
      conflict_info TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_worktrees_session ON worktrees(session_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_worktrees_branch ON worktrees(session_id, branch_name);
  `);

  return {
    db,
    upsertSession: db.prepare(`
      INSERT INTO sessions (id, project_dir, worktree_dir, status, model, current_claude_session_id)
      VALUES ($id, $projectDir, $worktreeDir, $status, $model, $currentClaudeSessionId)
      ON CONFLICT(id) DO UPDATE SET
        status = $status,
        model = COALESCE($model, sessions.model),
        current_claude_session_id = COALESCE($currentClaudeSessionId, sessions.current_claude_session_id),
        last_seen_at = datetime('now')
    `),
    updateSessionStatus: db.prepare(`
      UPDATE sessions SET status = $status, last_seen_at = datetime('now') WHERE id = $id
    `),
    insertEvent: db.prepare(`
      INSERT INTO events (session_id, type, tool_name, file_path, summary, payload)
      VALUES ($sessionId, $type, $toolName, $filePath, $summary, $payload)
      RETURNING id
    `),
    getEvent: db.prepare(`SELECT * FROM events WHERE id = $id`),
    getSession: db.prepare(`SELECT * FROM sessions WHERE id = $id`),
    getAllSessions: db.prepare(`SELECT * FROM sessions ORDER BY started_at DESC LIMIT 50`),
    getSessionEvents: db.prepare(`SELECT * FROM events WHERE session_id = $sessionId ORDER BY created_at DESC LIMIT 200`),
    getRecentEvents: db.prepare(`
      SELECT e.*, s.project_dir FROM events e
      JOIN sessions s ON e.session_id = s.id
      ORDER BY e.created_at DESC LIMIT 100
    `),
    insertAgent: db.prepare(`
      INSERT INTO agents (session_id, event_id, description, agent_type, prompt, status)
      VALUES ($sessionId, $eventId, $description, $agentType, $prompt, $status)
      RETURNING id
    `),
    getSessionAgents: db.prepare(`SELECT * FROM agents WHERE session_id = $sessionId ORDER BY created_at DESC`),

    // Session alias helpers
    getAlias: db.prepare(`SELECT dashboard_session_id FROM session_aliases WHERE claude_session_id = $claudeSessionId`),
    insertAlias: db.prepare(`INSERT OR REPLACE INTO session_aliases (claude_session_id, dashboard_session_id) VALUES ($claudeSessionId, $dashboardSessionId)`),
    findActiveSessionByDir: db.prepare(`SELECT id FROM sessions WHERE project_dir = $projectDir AND status = 'active' ORDER BY last_seen_at DESC LIMIT 1`),
    findRecentSessionByDir: db.prepare(`SELECT id FROM sessions WHERE project_dir = $projectDir ORDER BY last_seen_at DESC LIMIT 1`),
  };
}

function resolveSessionId(testDb, claudeSessionId, projectDir) {
  const existing = testDb.getAlias.get({ $claudeSessionId: claudeSessionId });
  if (existing) return existing.dashboard_session_id;

  if (projectDir && projectDir !== "unknown") {
    const active = testDb.findActiveSessionByDir.get({ $projectDir: projectDir });
    if (active) {
      testDb.insertAlias.run({ $claudeSessionId: claudeSessionId, $dashboardSessionId: active.id });
      return active.id;
    }
    const recent = testDb.findRecentSessionByDir.get({ $projectDir: projectDir });
    if (recent) {
      testDb.insertAlias.run({ $claudeSessionId: claudeSessionId, $dashboardSessionId: recent.id });
      return recent.id;
    }
  }

  testDb.insertAlias.run({ $claudeSessionId: claudeSessionId, $dashboardSessionId: claudeSessionId });
  return claudeSessionId;
}

function lookupSessionId(testDb, claudeSessionId) {
  const existing = testDb.getAlias.get({ $claudeSessionId: claudeSessionId });
  return existing ? existing.dashboard_session_id : claudeSessionId;
}

// ─── Build test Fastify app ─────────────────────────────────────────────────

function deleteSession(testDb, sessionId) {
  const session = testDb.getSession.get({ $id: sessionId });
  if (!session) return false;
  if (session.status === "active") return false;

  testDb.db.exec(`DELETE FROM worktrees WHERE session_id = '${sessionId}'`);
  testDb.db.exec(`DELETE FROM agents WHERE session_id = '${sessionId}'`);
  testDb.db.exec(`DELETE FROM events WHERE session_id = '${sessionId}'`);
  testDb.db.exec(`DELETE FROM session_aliases WHERE dashboard_session_id = '${sessionId}'`);
  testDb.db.prepare(`DELETE FROM sessions WHERE id = $id`).run({ $id: sessionId });

  return true;
}

function buildApp(testDb) {
  const app = Fastify({ logger: false });

  // Custom JSON parser to handle empty bodies
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    if (!body || body.length === 0) {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      done(err, undefined);
    }
  });

  // POST /api/sessions
  app.post("/api/sessions", async (req, reply) => {
    const body = req.body ?? {};
    const claudeSessionId = body.sessionId;
    const projectDir = body.projectDir || "unknown";

    if (!claudeSessionId) {
      return reply.code(400).send({ error: "sessionId is required" });
    }

    const sessionId = resolveSessionId(testDb, claudeSessionId, projectDir);

    testDb.upsertSession.run({
      $id: sessionId,
      $projectDir: projectDir,
      $worktreeDir: body.worktreeDir ?? null,
      $status: "active",
      $model: body.model || null,
      $currentClaudeSessionId: claudeSessionId,
    });

    return { ok: true };
  });

  // POST /api/sessions/:sessionId/stop
  app.post("/api/sessions/:sessionId/stop", async (req, reply) => {
    const sessionId = lookupSessionId(testDb, req.params.sessionId);
    try {
      testDb.updateSessionStatus.run({ $id: sessionId, $status: "stopped" });
    } catch (err) {
      // Session might not exist
    }
    return { ok: true };
  });

  // POST /api/events
  app.post("/api/events", async (req, reply) => {
    const body = req.body ?? {};
    const claudeSessionId = body.sessionId;

    if (!claudeSessionId) {
      return reply.code(400).send({ error: "sessionId is required" });
    }

    const sessionId = resolveSessionId(testDb, claudeSessionId, body.projectDir || "unknown");

    // Auto-create session if needed
    testDb.upsertSession.run({
      $id: sessionId,
      $projectDir: body.projectDir || "unknown",
      $worktreeDir: null,
      $status: "active",
      $model: null,
      $currentClaudeSessionId: null,
    });

    const { id: eventId } = testDb.insertEvent.get({
      $sessionId: sessionId,
      $type: body.type ?? "tool_use",
      $toolName: body.toolName ?? null,
      $filePath: body.filePath ?? null,
      $summary: body.summary ?? null,
      $payload: body.payload ? JSON.stringify(body.payload) : null,
    });

    // Auto-detect Agent tool calls
    if (body.toolName === "Agent" && body.payload) {
      const input = body.payload.input ?? {};
      const description = input.description || input.prompt?.slice(0, 120) || "Sub-agent";
      const agentType = input.subagent_type || "general-purpose";
      const prompt = input.prompt || null;

      testDb.insertAgent.get({
        $sessionId: sessionId,
        $eventId: eventId,
        $description: description,
        $agentType: agentType,
        $prompt: prompt ? prompt.slice(0, 2000) : null,
        $status: "completed",
      });
    }

    return { ok: true };
  });

  // GET /api/sessions
  app.get("/api/sessions", async () => {
    return testDb.getAllSessions.all();
  });

  // GET /api/sessions/:sessionId/events
  app.get("/api/sessions/:sessionId/events", async (req) => {
    const sessionId = lookupSessionId(testDb, req.params.sessionId);
    return testDb.getSessionEvents.all({ $sessionId: sessionId });
  });

  // GET /api/events/:eventId
  app.get("/api/events/:eventId", async (req, reply) => {
    const event = testDb.getEvent.get({ $id: Number(req.params.eventId) });
    if (!event) return reply.code(404).send({ error: "Event not found" });
    return event;
  });

  // GET /api/events
  app.get("/api/events", async () => {
    return testDb.getRecentEvents.all();
  });

  // GET /api/sessions/:sessionId/agents
  app.get("/api/sessions/:sessionId/agents", async (req) => {
    const sessionId = lookupSessionId(testDb, req.params.sessionId);
    return testDb.getSessionAgents.all({ $sessionId: sessionId });
  });

  // DELETE /api/sessions/:sessionId
  app.delete("/api/sessions/:sessionId", async (req, reply) => {
    const sessionId = lookupSessionId(testDb, req.params.sessionId);
    const deleted = deleteSession(testDb, sessionId);
    if (!deleted) {
      return reply.code(400).send({ error: "Session not found or still active" });
    }
    return { ok: true };
  });

  // GET /api/health
  app.get("/api/health", async () => ({ status: "ok", uptime: process.uptime() }));

  // Worktree DB helpers (no git operations — just DB CRUD)
  const insertWorktree = testDb.db.prepare(`
    INSERT INTO worktrees (session_id, branch_name, base_branch, description, agent_id, status)
    VALUES ($sessionId, $branchName, $baseBranch, $description, $agentId, $status)
    ON CONFLICT (session_id, branch_name) DO UPDATE SET
      description = excluded.description,
      agent_id = excluded.agent_id,
      status = excluded.status,
      updated_at = datetime('now')
    RETURNING id
  `);
  const getWorktree = testDb.db.prepare(`SELECT * FROM worktrees WHERE id = $id`);
  const getSessionWorktrees = testDb.db.prepare(`SELECT * FROM worktrees WHERE session_id = $sessionId ORDER BY created_at DESC`);
  const updateWorktreeStatus = testDb.db.prepare(`UPDATE worktrees SET status = $status, updated_at = datetime('now') WHERE id = $id`);

  app.get("/api/sessions/:sessionId/worktrees", async (req) => {
    const sessionId = lookupSessionId(testDb, req.params.sessionId);
    return getSessionWorktrees.all({ $sessionId: sessionId });
  });

  app.post("/api/sessions/:sessionId/worktrees", async (req) => {
    const sessionId = lookupSessionId(testDb, req.params.sessionId);
    const { branchName, baseBranch, description, agentId } = req.body;
    const { id } = insertWorktree.get({
      $sessionId: sessionId,
      $branchName: branchName,
      $baseBranch: baseBranch || "main",
      $description: description || null,
      $agentId: agentId || null,
      $status: "pending",
    });
    return { ok: true, id };
  });

  return { app, insertWorktree, getWorktree, getSessionWorktrees, updateWorktreeStatus };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("API integration tests", () => {
  let app;
  let testDb;
  let worktreeHelpers;

  beforeAll(async () => {
    testDb = createTestDb();
    const built = buildApp(testDb);
    app = built.app;
    worktreeHelpers = built;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    testDb.db.close();
  });

  // ─── Health check ───────────────────────────────────────────────────

  describe("GET /api/health", () => {
    it("returns ok status", async () => {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("ok");
      expect(typeof body.uptime).toBe("number");
    });
  });

  // ─── Session management ─────────────────────────────────────────────

  describe("POST /api/sessions", () => {
    it("creates a new session", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: {
          sessionId: "test-session-1",
          projectDir: "/home/user/project-a",
          model: "claude-sonnet-4-20250514",
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);

      const session = testDb.getSession.get({ $id: "test-session-1" });
      expect(session).toBeTruthy();
      expect(session.project_dir).toBe("/home/user/project-a");
      expect(session.status).toBe("active");
      expect(session.model).toBe("claude-sonnet-4-20250514");
    });

    it("returns 400 if sessionId is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectDir: "/some/dir" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("sessionId is required");
    });

    it("defaults projectDir to 'unknown'", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "test-session-no-dir" },
      });
      expect(res.statusCode).toBe(200);

      const session = testDb.getSession.get({ $id: "test-session-no-dir" });
      expect(session.project_dir).toBe("unknown");
    });

    it("upserts existing session (updates last_seen_at)", async () => {
      // Create session
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "upsert-test", projectDir: "/a" },
      });
      const first = testDb.getSession.get({ $id: "upsert-test" });

      // Upsert
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "upsert-test", projectDir: "/a", model: "opus" },
      });
      const second = testDb.getSession.get({ $id: "upsert-test" });

      expect(second.model).toBe("opus");
    });

    it("stores worktreeDir when provided", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: {
          sessionId: "worktree-session",
          projectDir: "/home/user/project",
          worktreeDir: "/tmp/worktree-123",
        },
      });
      expect(res.statusCode).toBe(200);
      const session = testDb.getSession.get({ $id: "worktree-session" });
      expect(session.worktree_dir).toBe("/tmp/worktree-123");
    });
  });

  // ─── Session stop ───────────────────────────────────────────────────

  describe("POST /api/sessions/:sessionId/stop", () => {
    it("marks session as stopped", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "stop-test", projectDir: "/b" },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/stop-test/stop",
      });
      expect(res.statusCode).toBe(200);

      const session = testDb.getSession.get({ $id: "stop-test" });
      expect(session.status).toBe("stopped");
    });

    it("doesn't crash for non-existent session", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/nonexistent-session/stop",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
    });
  });

  // ─── Events ─────────────────────────────────────────────────────────

  describe("POST /api/events", () => {
    it("creates an event linked to a session", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "event-session", projectDir: "/c" },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/events",
        payload: {
          sessionId: "event-session",
          type: "tool_use",
          toolName: "Read",
          filePath: "/c/src/index.ts",
          summary: "Read file src/index.ts",
        },
      });
      expect(res.statusCode).toBe(200);

      const events = testDb.getSessionEvents.all({ $sessionId: "event-session" });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events[0].tool_name).toBe("Read");
    });

    it("returns 400 if sessionId is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/events",
        payload: { toolName: "Read" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("auto-creates session if event arrives before SessionStart", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/events",
        payload: {
          sessionId: "auto-create-session",
          projectDir: "/d",
          toolName: "Bash",
          summary: "npm install",
        },
      });
      expect(res.statusCode).toBe(200);

      const session = testDb.getSession.get({ $id: "auto-create-session" });
      expect(session).toBeTruthy();
      expect(session.status).toBe("active");
    });

    it("stores payload as JSON string", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "payload-session", projectDir: "/e" },
      });

      await app.inject({
        method: "POST",
        url: "/api/events",
        payload: {
          sessionId: "payload-session",
          toolName: "Read",
          payload: { input: { file_path: "/foo.ts" }, response: "contents..." },
        },
      });

      const events = testDb.getSessionEvents.all({ $sessionId: "payload-session" });
      const parsed = JSON.parse(events[0].payload);
      expect(parsed.input.file_path).toBe("/foo.ts");
    });

    it("handles null payload gracefully", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "null-payload", projectDir: "/f" },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/events",
        payload: {
          sessionId: "null-payload",
          toolName: "Read",
        },
      });
      expect(res.statusCode).toBe(200);

      const events = testDb.getSessionEvents.all({ $sessionId: "null-payload" });
      expect(events[0].payload).toBeNull();
    });
  });

  // ─── Agent detection ────────────────────────────────────────────────

  describe("Agent auto-detection", () => {
    it("creates agent record when Agent tool event is posted", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "agent-detect-session", projectDir: "/g" },
      });

      await app.inject({
        method: "POST",
        url: "/api/events",
        payload: {
          sessionId: "agent-detect-session",
          toolName: "Agent",
          payload: {
            input: {
              description: "Search codebase",
              subagent_type: "Explore",
              prompt: "Find all API endpoints in the codebase",
            },
          },
        },
      });

      const agents = testDb.getSessionAgents.all({ $sessionId: "agent-detect-session" });
      expect(agents).toHaveLength(1);
      expect(agents[0].description).toBe("Search codebase");
      expect(agents[0].agent_type).toBe("Explore");
      expect(agents[0].prompt).toContain("Find all API endpoints");
      expect(agents[0].status).toBe("completed");
    });

    it("does not create agent for non-Agent tools", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "no-agent-session", projectDir: "/h" },
      });

      await app.inject({
        method: "POST",
        url: "/api/events",
        payload: {
          sessionId: "no-agent-session",
          toolName: "Read",
          payload: { input: { file_path: "/foo.ts" } },
        },
      });

      const agents = testDb.getSessionAgents.all({ $sessionId: "no-agent-session" });
      expect(agents).toHaveLength(0);
    });

    it("falls back to prompt snippet for description", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "agent-fallback", projectDir: "/i" },
      });

      await app.inject({
        method: "POST",
        url: "/api/events",
        payload: {
          sessionId: "agent-fallback",
          toolName: "Agent",
          payload: {
            input: {
              prompt: "A very long prompt that should be truncated to 120 characters for the description field since no explicit description was provided by the caller",
            },
          },
        },
      });

      const agents = testDb.getSessionAgents.all({ $sessionId: "agent-fallback" });
      expect(agents[0].description.length).toBeLessThanOrEqual(120);
      expect(agents[0].agent_type).toBe("general-purpose");
    });

    it("defaults to 'Sub-agent' description when no prompt or description", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "agent-default", projectDir: "/j" },
      });

      await app.inject({
        method: "POST",
        url: "/api/events",
        payload: {
          sessionId: "agent-default",
          toolName: "Agent",
          payload: { input: {} },
        },
      });

      const agents = testDb.getSessionAgents.all({ $sessionId: "agent-default" });
      expect(agents[0].description).toBe("Sub-agent");
    });

    it("truncates long prompts to 2000 chars", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "agent-long-prompt", projectDir: "/k" },
      });

      const longPrompt = "x".repeat(5000);
      await app.inject({
        method: "POST",
        url: "/api/events",
        payload: {
          sessionId: "agent-long-prompt",
          toolName: "Agent",
          payload: {
            input: { description: "test", prompt: longPrompt },
          },
        },
      });

      const agents = testDb.getSessionAgents.all({ $sessionId: "agent-long-prompt" });
      expect(agents[0].prompt.length).toBe(2000);
    });
  });

  // ─── GET endpoints ──────────────────────────────────────────────────

  describe("GET /api/sessions", () => {
    it("returns all sessions", async () => {
      const res = await app.inject({ method: "GET", url: "/api/sessions" });
      expect(res.statusCode).toBe(200);
      const sessions = res.json();
      expect(Array.isArray(sessions)).toBe(true);
      expect(sessions.length).toBeGreaterThan(0);
    });
  });

  describe("GET /api/sessions/:sessionId/events", () => {
    it("returns events for a session", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions/event-session/events",
      });
      expect(res.statusCode).toBe(200);
      const events = res.json();
      expect(Array.isArray(events)).toBe(true);
    });

    it("returns empty array for session with no events", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "no-events", projectDir: "/z" },
      });
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions/no-events/events",
      });
      expect(res.json()).toEqual([]);
    });
  });

  describe("GET /api/events/:eventId", () => {
    it("returns 404 for non-existent event", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/events/999999",
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("Event not found");
    });

    it("returns event with full payload", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "full-event-test", projectDir: "/l" },
      });

      await app.inject({
        method: "POST",
        url: "/api/events",
        payload: {
          sessionId: "full-event-test",
          toolName: "Edit",
          summary: "Edited foo.ts",
          payload: { input: { file_path: "/l/foo.ts" } },
        },
      });

      const events = testDb.getSessionEvents.all({ $sessionId: "full-event-test" });
      const eventId = events[0].id;

      const res = await app.inject({
        method: "GET",
        url: `/api/events/${eventId}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().tool_name).toBe("Edit");
      expect(res.json().payload).toBeTruthy();
    });
  });

  describe("GET /api/events", () => {
    it("returns recent events across all sessions", async () => {
      const res = await app.inject({ method: "GET", url: "/api/events" });
      expect(res.statusCode).toBe(200);
      const events = res.json();
      expect(Array.isArray(events)).toBe(true);
    });
  });

  describe("GET /api/sessions/:sessionId/agents", () => {
    it("returns agents for a session", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions/agent-detect-session/agents",
      });
      expect(res.statusCode).toBe(200);
      const agents = res.json();
      expect(agents.length).toBeGreaterThanOrEqual(1);
    });

    it("returns empty array for session with no agents", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/api/sessions/no-events/agents",
      });
      expect(res.json()).toEqual([]);
    });
  });

  // ─── Session alias resolution ───────────────────────────────────────

  describe("session alias resolution", () => {
    it("aliases a new CLI session to an existing active session for the same dir", async () => {
      // Create first session
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "alias-original", projectDir: "/alias-test" },
      });

      // Second CLI session for same project should alias to the first
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "alias-reconnect", projectDir: "/alias-test" },
      });

      const alias = testDb.getAlias.get({ $claudeSessionId: "alias-reconnect" });
      expect(alias.dashboard_session_id).toBe("alias-original");
    });

    it("creates a new session for a different project dir", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "diff-dir-1", projectDir: "/project-x" },
      });

      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "diff-dir-2", projectDir: "/project-y" },
      });

      const alias = testDb.getAlias.get({ $claudeSessionId: "diff-dir-2" });
      expect(alias.dashboard_session_id).toBe("diff-dir-2");
    });

    it("handles 'unknown' project dir by creating new session", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "unknown-dir-1" },
      });

      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "unknown-dir-2" },
      });

      const alias1 = testDb.getAlias.get({ $claudeSessionId: "unknown-dir-1" });
      const alias2 = testDb.getAlias.get({ $claudeSessionId: "unknown-dir-2" });
      // Each should be its own session since project_dir is "unknown"
      expect(alias1.dashboard_session_id).toBe("unknown-dir-1");
      expect(alias2.dashboard_session_id).toBe("unknown-dir-2");
    });
  });

  // ─── Custom JSON parser ─────────────────────────────────────────────

  describe("custom JSON parser", () => {
    it("handles empty body as empty object", async () => {
      // The stop endpoint sends empty body
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "empty-body-test", projectDir: "/m" },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/empty-body-test/stop",
        headers: { "content-type": "application/json" },
        body: "",
      });
      expect(res.statusCode).toBe(200);
    });
  });

  // ─── Session deletion ─────────────────────────────────────────────

  describe("DELETE /api/sessions/:sessionId", () => {
    it("deletes a stopped session and its events", async () => {
      // Create and populate session
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "delete-me", projectDir: "/del" },
      });
      await app.inject({
        method: "POST",
        url: "/api/events",
        payload: { sessionId: "delete-me", toolName: "Read", summary: "test" },
      });
      // Stop it first
      await app.inject({
        method: "POST",
        url: "/api/sessions/delete-me/stop",
      });

      const res = await app.inject({
        method: "DELETE",
        url: "/api/sessions/delete-me",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);

      // Verify session and events are gone
      const session = testDb.getSession.get({ $id: "delete-me" });
      expect(session).toBeNull();
      const events = testDb.getSessionEvents.all({ $sessionId: "delete-me" });
      expect(events).toHaveLength(0);
    });

    it("returns 400 for active sessions", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "still-active", projectDir: "/active" },
      });

      const res = await app.inject({
        method: "DELETE",
        url: "/api/sessions/still-active",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Session not found or still active");
    });

    it("returns 400 for non-existent sessions", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/api/sessions/does-not-exist-xyz",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("Session not found or still active");
    });

    it("cascading delete removes agents too", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "del-with-agents", projectDir: "/delag" },
      });
      await app.inject({
        method: "POST",
        url: "/api/events",
        payload: {
          sessionId: "del-with-agents",
          toolName: "Agent",
          payload: { input: { description: "test agent", prompt: "do something" } },
        },
      });
      await app.inject({
        method: "POST",
        url: "/api/sessions/del-with-agents/stop",
      });

      // Verify agent exists before delete
      const agentsBefore = testDb.getSessionAgents.all({ $sessionId: "del-with-agents" });
      expect(agentsBefore.length).toBeGreaterThan(0);

      const res = await app.inject({ method: "DELETE", url: "/api/sessions/del-with-agents" });
      expect(res.statusCode).toBe(200);

      const agentsAfter = testDb.getSessionAgents.all({ $sessionId: "del-with-agents" });
      expect(agentsAfter).toHaveLength(0);
    });
  });

  // ─── Worktree DB operations ───────────────────────────────────────

  describe("Worktree DB operations", () => {
    it("creates and lists worktrees for a session", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "wt-session", projectDir: "/wt" },
      });

      const createRes = await app.inject({
        method: "POST",
        url: "/api/sessions/wt-session/worktrees",
        payload: {
          branchName: "agent/fix-bug-abc123",
          baseBranch: "main",
          description: "fix bug",
        },
      });
      expect(createRes.statusCode).toBe(200);
      expect(createRes.json().ok).toBe(true);

      const listRes = await app.inject({
        method: "GET",
        url: "/api/sessions/wt-session/worktrees",
      });
      expect(listRes.statusCode).toBe(200);
      const worktrees = listRes.json();
      expect(worktrees.length).toBeGreaterThanOrEqual(1);
      expect(worktrees[0].branch_name).toBe("agent/fix-bug-abc123");
      expect(worktrees[0].base_branch).toBe("main");
      expect(worktrees[0].description).toBe("fix bug");
    });

    it("enforces unique constraint on (session_id, branch_name)", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "wt-unique", projectDir: "/wtu" },
      });

      await app.inject({
        method: "POST",
        url: "/api/sessions/wt-unique/worktrees",
        payload: { branchName: "agent/dupe-branch", description: "first" },
      });

      // Second insert with same branch should upsert (ON CONFLICT DO UPDATE)
      const res = await app.inject({
        method: "POST",
        url: "/api/sessions/wt-unique/worktrees",
        payload: { branchName: "agent/dupe-branch", description: "updated" },
      });
      expect(res.statusCode).toBe(200);

      const list = await app.inject({
        method: "GET",
        url: "/api/sessions/wt-unique/worktrees",
      });
      const worktrees = list.json();
      const matching = worktrees.filter((w) => w.branch_name === "agent/dupe-branch");
      expect(matching).toHaveLength(1);
      expect(matching[0].description).toBe("updated");
    });

    it("worktrees are cascade-deleted with session", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "wt-cascade", projectDir: "/wtc" },
      });
      await app.inject({
        method: "POST",
        url: "/api/sessions/wt-cascade/worktrees",
        payload: { branchName: "agent/cascade-test", description: "will be deleted" },
      });
      await app.inject({
        method: "POST",
        url: "/api/sessions/wt-cascade/stop",
      });

      const res = await app.inject({ method: "DELETE", url: "/api/sessions/wt-cascade" });
      expect(res.statusCode).toBe(200);

      // Verify worktrees are gone (using raw DB since session no longer exists)
      const remaining = testDb.db
        .prepare("SELECT * FROM worktrees WHERE session_id = $sid")
        .all({ $sid: "wt-cascade" });
      expect(remaining).toHaveLength(0);
    });

    it("returns empty worktree list for session with no worktrees", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "no-wt", projectDir: "/nowt" },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/sessions/no-wt/worktrees",
      });
      expect(res.json()).toEqual([]);
    });
  });

  // ─── Event edge cases ─────────────────────────────────────────────

  describe("Event edge cases", () => {
    it("defaults event type to tool_use", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "type-default", projectDir: "/td" },
      });
      await app.inject({
        method: "POST",
        url: "/api/events",
        payload: { sessionId: "type-default", toolName: "Bash" },
      });

      const events = testDb.getSessionEvents.all({ $sessionId: "type-default" });
      expect(events[0].type).toBe("tool_use");
    });

    it("preserves custom event type", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "custom-type", projectDir: "/ct" },
      });
      await app.inject({
        method: "POST",
        url: "/api/events",
        payload: { sessionId: "custom-type", type: "lifecycle", toolName: "SessionStart" },
      });

      const events = testDb.getSessionEvents.all({ $sessionId: "custom-type" });
      expect(events[0].type).toBe("lifecycle");
    });

    it("handles events with all optional fields null", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "minimal-event", projectDir: "/min" },
      });
      const res = await app.inject({
        method: "POST",
        url: "/api/events",
        payload: { sessionId: "minimal-event" },
      });
      expect(res.statusCode).toBe(200);

      const events = testDb.getSessionEvents.all({ $sessionId: "minimal-event" });
      expect(events[0].tool_name).toBeNull();
      expect(events[0].file_path).toBeNull();
      expect(events[0].summary).toBeNull();
      expect(events[0].payload).toBeNull();
    });
  });

  // ─── Session model preservation ────────────────────────────────────

  describe("Session model handling", () => {
    it("preserves existing model when new upsert sends null", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "model-keep", projectDir: "/mk", model: "claude-opus-4-20250514" },
      });

      // Upsert without model (e.g., from a hook that doesn't include it)
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "model-keep", projectDir: "/mk" },
      });

      const session = testDb.getSession.get({ $id: "model-keep" });
      expect(session.model).toBe("claude-opus-4-20250514");
    });

    it("updates model when a new value is provided", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "model-update", projectDir: "/mu", model: "old-model" },
      });
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "model-update", projectDir: "/mu", model: "new-model" },
      });

      const session = testDb.getSession.get({ $id: "model-update" });
      expect(session.model).toBe("new-model");
    });
  });

  // ─── Alias resolution via event endpoint ──────────────────────────

  describe("Event-triggered alias resolution", () => {
    it("event for same project_dir aliases to existing session", async () => {
      // Create initial session
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "ev-alias-orig", projectDir: "/ev-alias" },
      });

      // Post event from a different CLI session ID but same dir
      await app.inject({
        method: "POST",
        url: "/api/events",
        payload: { sessionId: "ev-alias-new", projectDir: "/ev-alias", toolName: "Read" },
      });

      // The event should be under the original session
      const events = testDb.getSessionEvents.all({ $sessionId: "ev-alias-orig" });
      expect(events.some((e) => e.tool_name === "Read")).toBe(true);

      // And the alias should exist
      const alias = testDb.getAlias.get({ $claudeSessionId: "ev-alias-new" });
      expect(alias.dashboard_session_id).toBe("ev-alias-orig");
    });

    it("event with unknown dir creates a new session", async () => {
      await app.inject({
        method: "POST",
        url: "/api/events",
        payload: { sessionId: "ev-unknown-dir", toolName: "Bash" },
      });

      // Should create its own session
      const session = testDb.getSession.get({ $id: "ev-unknown-dir" });
      expect(session).toBeTruthy();
      expect(session.project_dir).toBe("unknown");
    });
  });

  // ─── Session reactivation ────────────────────────────────────────

  describe("Session reactivation", () => {
    it("session can be reactivated after being stopped", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "reactivate", projectDir: "/react" },
      });
      await app.inject({
        method: "POST",
        url: "/api/sessions/reactivate/stop",
      });

      const stopped = testDb.getSession.get({ $id: "reactivate" });
      expect(stopped.status).toBe("stopped");

      // Reactivate via new upsert
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "reactivate", projectDir: "/react" },
      });

      const reactivated = testDb.getSession.get({ $id: "reactivate" });
      expect(reactivated.status).toBe("active");
    });
  });

  // ─── current_claude_session_id tracking ──────────────────────────

  describe("current_claude_session_id", () => {
    it("stores the Claude CLI session ID on create", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "cli-id-track", projectDir: "/cliid" },
      });

      const session = testDb.getSession.get({ $id: "cli-id-track" });
      expect(session.current_claude_session_id).toBe("cli-id-track");
    });

    it("preserves existing cli session id when null is passed via COALESCE", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "cli-coalesce", projectDir: "/coal" },
      });

      // Simulate an upsert that passes null for current_claude_session_id
      testDb.upsertSession.run({
        $id: "cli-coalesce",
        $projectDir: "/coal",
        $worktreeDir: null,
        $status: "active",
        $model: null,
        $currentClaudeSessionId: null,
      });

      const session = testDb.getSession.get({ $id: "cli-coalesce" });
      expect(session.current_claude_session_id).toBe("cli-coalesce");
    });
  });

  // ─── Worktree status updates ─────────────────────────────────────

  describe("Worktree status lifecycle", () => {
    it("updates worktree status from pending to ready", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "wt-status", projectDir: "/wts" },
      });

      const { id: wtId } = worktreeHelpers.insertWorktree.get({
        $sessionId: "wt-status",
        $branchName: "agent/status-test",
        $baseBranch: "main",
        $description: "status test",
        $agentId: null,
        $status: "pending",
      });

      worktreeHelpers.updateWorktreeStatus.run({ $id: wtId, $status: "ready" });
      const wt = worktreeHelpers.getWorktree.get({ $id: wtId });
      expect(wt.status).toBe("ready");
    });

    it("updates worktree status to merged", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "wt-merge", projectDir: "/wtm" },
      });

      const { id: wtId } = worktreeHelpers.insertWorktree.get({
        $sessionId: "wt-merge",
        $branchName: "agent/merge-test",
        $baseBranch: "main",
        $description: "merge test",
        $agentId: null,
        $status: "ready",
      });

      worktreeHelpers.updateWorktreeStatus.run({ $id: wtId, $status: "merged" });
      const wt = worktreeHelpers.getWorktree.get({ $id: wtId });
      expect(wt.status).toBe("merged");
    });
  });

  // ─── Multiple events per session ──────────────────────────────────

  describe("Event ordering and limits", () => {
    it("returns all events for a session", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "order-test", projectDir: "/order" },
      });

      const tools = ["Read", "Write", "Bash", "Edit", "Glob"];
      for (const tool of tools) {
        await app.inject({
          method: "POST",
          url: "/api/events",
          payload: { sessionId: "order-test", toolName: tool, summary: `${tool} op` },
        });
      }

      const res = await app.inject({
        method: "GET",
        url: "/api/sessions/order-test/events",
      });
      const events = res.json();
      expect(events.length).toBe(5);

      // All tools should be present
      const toolNames = events.map((e) => e.tool_name).sort();
      expect(toolNames).toEqual(["Bash", "Edit", "Glob", "Read", "Write"]);
    });

    it("GET /api/events returns events with project_dir from join", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "join-test", projectDir: "/joined" },
      });
      await app.inject({
        method: "POST",
        url: "/api/events",
        payload: { sessionId: "join-test", toolName: "Read" },
      });

      const res = await app.inject({ method: "GET", url: "/api/events" });
      const events = res.json();
      const found = events.find((e) => e.session_id === "join-test");
      expect(found).toBeTruthy();
      expect(found.project_dir).toBe("/joined");
    });
  });

  // ─── Agent with no payload ────────────────────────────────────────

  describe("Agent detection edge cases", () => {
    it("does not create agent when Agent event has no payload", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "agent-no-payload", projectDir: "/anp" },
      });

      await app.inject({
        method: "POST",
        url: "/api/events",
        payload: { sessionId: "agent-no-payload", toolName: "Agent" },
      });

      const agents = testDb.getSessionAgents.all({ $sessionId: "agent-no-payload" });
      expect(agents).toHaveLength(0);
    });

    it("handles Agent with empty input object", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "agent-empty-input", projectDir: "/aei" },
      });

      await app.inject({
        method: "POST",
        url: "/api/events",
        payload: {
          sessionId: "agent-empty-input",
          toolName: "Agent",
          payload: { input: {} },
        },
      });

      const agents = testDb.getSessionAgents.all({ $sessionId: "agent-empty-input" });
      expect(agents).toHaveLength(1);
      expect(agents[0].description).toBe("Sub-agent");
      expect(agents[0].agent_type).toBe("general-purpose");
      expect(agents[0].prompt).toBeNull();
    });

    it("handles multiple agents in the same session", async () => {
      await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { sessionId: "multi-agent", projectDir: "/ma" },
      });

      for (let i = 0; i < 3; i++) {
        await app.inject({
          method: "POST",
          url: "/api/events",
          payload: {
            sessionId: "multi-agent",
            toolName: "Agent",
            payload: { input: { description: `agent-${i}`, subagent_type: "Explore", prompt: `task ${i}` } },
          },
        });
      }

      const agents = testDb.getSessionAgents.all({ $sessionId: "multi-agent" });
      expect(agents).toHaveLength(3);
      // All three agents should exist (order may vary within the same second)
      const descriptions = agents.map((a) => a.description).sort();
      expect(descriptions).toEqual(["agent-0", "agent-1", "agent-2"]);
    });
  });
});
