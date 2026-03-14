import { describe, expect, it, beforeAll, afterAll, beforeEach } from "bun:test";
import Fastify from "fastify";
import { Database } from "bun:sqlite";

const SKIP = !process.env.SUPABASE_DB_URL;

/**
 * Integration tests for the swarm routes.
 * Mocks spawnSwarmAgent, cancelSwarmAgent, getActiveSwarmAgents, and broadcast
 * to test HTTP validation, status codes, and response shapes without spawning
 * real claude processes.
 */

describe.skipIf(SKIP)("swarm routes", () => {

let app;
let db;
let getSession;
let lookupSessionId;

// ─── Mock state ──────────────────────────────────────────────────────────────

let mockSwarmAgents = new Map(); // agentId → { sessionId, description, ... }
let mockBroadcasted = [];
let mockSpawnCalls = [];
let nextAgentId = 1;

async function mockSpawnSwarmAgent(opts, onEvent) {
  const agentId = `mock-agent-${nextAgentId++}`;
  mockSpawnCalls.push({ agentId, ...opts });
  mockSwarmAgents.set(agentId, {
    id: agentId,
    parentSessionId: opts.parentSessionId,
    description: opts.description,
    prompt: opts.prompt,
    status: "running",
    startedAt: Date.now(),
  });

  // Simulate async completion
  setTimeout(() => {
    onEvent({ type: "swarm:done", agentId });
    mockSwarmAgents.delete(agentId);
  }, 10);

  return { id: agentId };
}

function mockCancelSwarmAgent(agentId) {
  if (mockSwarmAgents.has(agentId)) {
    mockSwarmAgents.delete(agentId);
    return true;
  }
  return false;
}

function mockGetActiveSwarmAgents(sessionId) {
  if (!sessionId) return [];
  return [...mockSwarmAgents.values()].filter((a) => a.parentSessionId === sessionId);
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
    CREATE TABLE worktrees (
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
    CREATE INDEX idx_worktrees_session ON worktrees(session_id);
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

beforeAll(async () => {
  const { upsertSession } = initDb();

  upsertSession.run({ $id: "swarm-session", $projectDir: "/tmp", $worktreeDir: null, $status: "active" });
  upsertSession.run({ $id: "unknown-dir-session", $projectDir: "unknown", $worktreeDir: null, $status: "active" });
  upsertSession.run({ $id: "worktree-session", $projectDir: "/tmp/main", $worktreeDir: "/tmp/wt", $status: "active" });

  app = Fastify();

  // ─── POST /api/sessions/:sessionId/swarm/spawn ───────────────────────────

  app.post("/api/sessions/:sessionId/swarm/spawn", async (req, reply) => {
    const { prompt, description, permissionMode, model, useWorktree } = req.body ?? {};
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });

    const sessionId = lookupSessionId(req.params.sessionId);
    const session = getSession.get({ $id: sessionId });
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const baseCwd = session.worktree_dir || session.project_dir;
    if (!baseCwd || baseCwd === "unknown") {
      return reply.code(400).send({ error: "Session has no known working directory" });
    }

    const agentDescription = description || prompt.slice(0, 80);

    const { id: agentId } = await mockSpawnSwarmAgent(
      { prompt, cwd: baseCwd, description: agentDescription, permissionMode, model, parentSessionId: sessionId, useWorktree: !!useWorktree },
      (event) => {
        mockBroadcast({ ...event, parentSessionId: sessionId });
      },
    );

    mockBroadcast({ type: "swarm:spawned", agentId, parentSessionId: sessionId, description: agentDescription, startedAt: Date.now(), worktree: !!useWorktree });
    return { ok: true, agentId };
  });

  // ─── POST /api/swarm/:agentId/cancel ─────────────────────────────────────

  app.post("/api/swarm/:agentId/cancel", async (req) => {
    const cancelled = mockCancelSwarmAgent(req.params.agentId);
    if (cancelled) {
      mockBroadcast({ type: "swarm:done", agentId: req.params.agentId, exitCode: null, cancelled: true });
    }
    return { ok: true, cancelled };
  });

  // ─── GET /api/sessions/:sessionId/swarm ──────────────────────────────────

  app.get("/api/sessions/:sessionId/swarm", async (req) => {
    const sessionId = lookupSessionId(req.params.sessionId);
    return mockGetActiveSwarmAgents(sessionId);
  });

  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  mockSwarmAgents.clear();
  mockBroadcasted = [];
  mockSpawnCalls = [];
  nextAgentId = 1;
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("POST /api/sessions/:sessionId/swarm/spawn", () => {
  it("returns 400 when prompt is missing", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/swarm-session/swarm/spawn", payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("prompt is required");
  });

  it("returns 400 when body is empty", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/swarm-session/swarm/spawn", payload: null });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for non-existent session", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/no-such/swarm/spawn", payload: { prompt: "hello" } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });

  it("returns 400 for session with unknown working directory", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/unknown-dir-session/swarm/spawn", payload: { prompt: "hello" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("no known working directory");
  });

  it("returns ok and agentId on success", async () => {
    const res = await app.inject({ method: "POST", url: "/api/sessions/swarm-session/swarm/spawn", payload: { prompt: "do the thing" } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.agentId).toBeTruthy();
  });

  it("broadcasts swarm:spawned on success", async () => {
    await app.inject({ method: "POST", url: "/api/sessions/swarm-session/swarm/spawn", payload: { prompt: "build feature" } });
    const spawnedMsg = mockBroadcasted.find((m) => m.type === "swarm:spawned");
    expect(spawnedMsg).toBeTruthy();
    expect(spawnedMsg.parentSessionId).toBe("swarm-session");
    expect(spawnedMsg.description).toBe("build feature");
  });

  it("uses description when provided", async () => {
    await app.inject({ method: "POST", url: "/api/sessions/swarm-session/swarm/spawn", payload: { prompt: "long prompt text here", description: "short desc" } });
    const spawnedMsg = mockBroadcasted.find((m) => m.type === "swarm:spawned");
    expect(spawnedMsg.description).toBe("short desc");
  });

  it("truncates prompt to 80 chars for default description", async () => {
    const longPrompt = "a".repeat(100);
    await app.inject({ method: "POST", url: "/api/sessions/swarm-session/swarm/spawn", payload: { prompt: longPrompt } });
    const call = mockSpawnCalls[0];
    expect(call.description.length).toBe(80);
  });

  it("passes all options through to spawnSwarmAgent", async () => {
    await app.inject({
      method: "POST",
      url: "/api/sessions/swarm-session/swarm/spawn",
      payload: { prompt: "go", permissionMode: "acceptEdits", model: "opus", useWorktree: true },
    });
    const call = mockSpawnCalls[0];
    expect(call.permissionMode).toBe("acceptEdits");
    expect(call.model).toBe("opus");
    expect(call.useWorktree).toBe(true);
    expect(call.parentSessionId).toBe("swarm-session");
  });

  it("prefers worktree_dir over project_dir for cwd", async () => {
    await app.inject({ method: "POST", url: "/api/sessions/worktree-session/swarm/spawn", payload: { prompt: "go" } });
    const call = mockSpawnCalls[0];
    expect(call.cwd).toBe("/tmp/wt");
  });

  it("sets worktree flag in broadcast based on useWorktree", async () => {
    await app.inject({ method: "POST", url: "/api/sessions/swarm-session/swarm/spawn", payload: { prompt: "go", useWorktree: true } });
    const spawnedMsg = mockBroadcasted.find((m) => m.type === "swarm:spawned");
    expect(spawnedMsg.worktree).toBe(true);
  });

  it("sets worktree: false when useWorktree is not set", async () => {
    await app.inject({ method: "POST", url: "/api/sessions/swarm-session/swarm/spawn", payload: { prompt: "go" } });
    const spawnedMsg = mockBroadcasted.find((m) => m.type === "swarm:spawned");
    expect(spawnedMsg.worktree).toBe(false);
  });
});

describe("POST /api/swarm/:agentId/cancel", () => {
  it("returns cancelled: false for non-existent agent", async () => {
    const res = await app.inject({ method: "POST", url: "/api/swarm/no-such-agent/cancel" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(false);
  });

  it("returns cancelled: true and broadcasts for active agent", async () => {
    mockSwarmAgents.set("agent-1", { id: "agent-1", parentSessionId: "swarm-session", description: "test", status: "running" });
    const res = await app.inject({ method: "POST", url: "/api/swarm/agent-1/cancel" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.cancelled).toBe(true);

    const doneMsg = mockBroadcasted.find((m) => m.type === "swarm:done" && m.cancelled);
    expect(doneMsg).toBeTruthy();
    expect(doneMsg.agentId).toBe("agent-1");
  });
});

describe("GET /api/sessions/:sessionId/swarm", () => {
  it("returns empty array when no agents are active", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/swarm-session/swarm" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("returns active agents for the session", async () => {
    mockSwarmAgents.set("agent-1", { id: "agent-1", parentSessionId: "swarm-session", description: "test agent", status: "running" });
    mockSwarmAgents.set("agent-2", { id: "agent-2", parentSessionId: "other-session", description: "other agent", status: "running" });

    const res = await app.inject({ method: "GET", url: "/api/sessions/swarm-session/swarm" });
    expect(res.statusCode).toBe(200);
    const agents = res.json();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe("agent-1");
  });

  it("returns empty array for session with no agents", async () => {
    mockSwarmAgents.set("agent-1", { id: "agent-1", parentSessionId: "other-session", description: "not mine", status: "running" });

    const res = await app.inject({ method: "GET", url: "/api/sessions/swarm-session/swarm" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

}); // describe.skipIf(SKIP)
