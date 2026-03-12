import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import Fastify from "fastify";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { getArchitecture } from "./architecture.js";

/**
 * Integration tests for the architecture route.
 * Uses an in-memory SQLite database and a real project directory for scanning.
 */

const PROJECT_ROOT = join(import.meta.dir, "..");
let app;
let db;
let getSession;
let lookupSessionId;

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

beforeAll(async () => {
  const { upsertSession } = initDb();

  upsertSession.run({ $id: "arch-session", $projectDir: PROJECT_ROOT, $worktreeDir: null, $status: "active" });
  upsertSession.run({ $id: "unknown-dir-session", $projectDir: "unknown", $worktreeDir: null, $status: "active" });
  upsertSession.run({ $id: "bad-dir-session", $projectDir: "/nonexistent-dir-xyz-99999", $worktreeDir: null, $status: "active" });

  app = Fastify();

  // Mirror the real architecture route with our test DB
  app.get("/api/sessions/:id/architecture", async (req, reply) => {
    const sessionId = lookupSessionId(req.params.id);
    const session = getSession.get({ $id: sessionId });

    if (!session) {
      return reply.code(404).send({ error: "Session not found" });
    }

    const projectDir = session.project_dir;
    if (!projectDir || projectDir === "unknown") {
      return reply.code(400).send({ error: "Session has no project directory" });
    }

    try {
      const arch = await getArchitecture(projectDir);
      return { sessionId, projectDir, ...arch };
    } catch (err) {
      req.log.error(err, "Architecture scan failed");
      return reply.code(500).send({ error: "Failed to scan project architecture" });
    }
  });

  await app.ready();
});

afterAll(async () => {
  await app?.close();
});

describe("GET /api/sessions/:id/architecture", () => {
  it("returns 404 for non-existent session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/nope/architecture" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });

  it("returns 400 for session with unknown project dir", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/unknown-dir-session/architecture" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("no project directory");
  });

  it("returns architecture data for a valid session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/arch-session/architecture" });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.sessionId).toBe("arch-session");
    expect(body.projectDir).toBe(PROJECT_ROOT);
    // getArchitecture returns tree + flows
    expect(body).toHaveProperty("tree");
    expect(body).toHaveProperty("flows");
  });

  it("returns 200 with empty tree for nonexistent project dir", async () => {
    // getArchitecture swallows filesystem errors internally and returns
    // an empty tree + flows array rather than throwing
    const res = await app.inject({ method: "GET", url: "/api/sessions/bad-dir-session/architecture" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("tree");
    expect(body).toHaveProperty("flows");
  });
});
