import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";

/**
 * Tests for session alias resolution, lookup, and deletion logic.
 *
 * Since db.js creates a file-backed DB at import time, we replicate the
 * core resolution logic here with an in-memory database. This tests the
 * SQL and business logic without touching the real dashboard.db.
 */

// ─── Schema + statements ─────────────────────────────────────────────────────

function createTestDb() {
  const db = new Database(":memory:");
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

    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      type TEXT NOT NULL,
      tool_name TEXT,
      file_path TEXT,
      summary TEXT,
      payload TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_events_session ON events(session_id);

    CREATE TABLE session_aliases (
      claude_session_id TEXT PRIMARY KEY,
      dashboard_session_id TEXT NOT NULL
    );

    CREATE TABLE agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      event_id INTEGER REFERENCES events(id),
      description TEXT,
      agent_type TEXT,
      prompt TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    CREATE UNIQUE INDEX idx_worktrees_branch ON worktrees(session_id, branch_name);
  `);

  const stmts = {
    upsertSession: db.prepare(`
      INSERT INTO sessions (id, project_dir, worktree_dir, status, model, current_claude_session_id)
      VALUES ($id, $projectDir, $worktreeDir, $status, $model, $currentClaudeSessionId)
      ON CONFLICT(id) DO UPDATE SET
        status = $status,
        model = COALESCE($model, sessions.model),
        project_dir = CASE
          WHEN $projectDir != 'unknown' AND (sessions.project_dir = 'unknown' OR sessions.project_dir IS NULL)
            THEN $projectDir
          ELSE sessions.project_dir
        END,
        worktree_dir = CASE
          WHEN $worktreeDir = '__clear__' THEN NULL
          ELSE COALESCE($worktreeDir, sessions.worktree_dir)
        END,
        current_claude_session_id = COALESCE($currentClaudeSessionId, sessions.current_claude_session_id),
        last_seen_at = datetime('now')
    `),
    updateSessionStatus: db.prepare(`
      UPDATE sessions SET status = $status, last_seen_at = datetime('now') WHERE id = $id
    `),
    getSession: db.prepare(`SELECT * FROM sessions WHERE id = $id`),
    getAllSessions: db.prepare(`SELECT * FROM sessions ORDER BY started_at DESC LIMIT 50`),
    getAlias: db.prepare(`SELECT dashboard_session_id FROM session_aliases WHERE claude_session_id = $claudeSessionId`),
    insertAlias: db.prepare(`INSERT OR REPLACE INTO session_aliases (claude_session_id, dashboard_session_id) VALUES ($claudeSessionId, $dashboardSessionId)`),
    findActiveSessionByDir: db.prepare(`
      SELECT id FROM sessions WHERE project_dir = $projectDir AND status = 'active'
      ORDER BY last_seen_at DESC LIMIT 1
    `),
    findRecentSessionByDir: db.prepare(`
      SELECT id FROM sessions WHERE project_dir = $projectDir AND last_seen_at >= datetime('now', '-30 minutes')
      ORDER BY last_seen_at DESC LIMIT 1
    `),
    insertEvent: db.prepare(`
      INSERT INTO events (session_id, type, tool_name, file_path, summary, payload)
      VALUES ($sessionId, $type, $toolName, $filePath, $summary, $payload)
      RETURNING id
    `),
    insertAgent: db.prepare(`
      INSERT INTO agents (session_id, event_id, description, agent_type, prompt, status)
      VALUES ($sessionId, $eventId, $description, $agentType, $prompt, $status)
      RETURNING id
    `),
    insertWorktree: db.prepare(`
      INSERT INTO worktrees (session_id, branch_name, base_branch, description, agent_id, status)
      VALUES ($sessionId, $branchName, $baseBranch, $description, $agentId, $status)
      ON CONFLICT (session_id, branch_name) DO UPDATE SET
        description = excluded.description,
        status = excluded.status,
        updated_at = datetime('now')
      RETURNING id
    `),
    getSessionWorktrees: db.prepare(`SELECT * FROM worktrees WHERE session_id = $sessionId`),
    getSessionAgents: db.prepare(`SELECT * FROM agents WHERE session_id = $sessionId`),
    getSessionEvents: db.prepare(`SELECT * FROM events WHERE session_id = $sessionId`),
    deleteSessionAliases: db.prepare(`DELETE FROM session_aliases WHERE dashboard_session_id = $sessionId`),
    deleteSessionWorktrees: db.prepare(`DELETE FROM worktrees WHERE session_id = $sessionId`),
    deleteSessionAgents: db.prepare(`DELETE FROM agents WHERE session_id = $sessionId`),
    deleteSessionEvents: db.prepare(`DELETE FROM events WHERE session_id = $sessionId`),
    deleteSessionRow: db.prepare(`DELETE FROM sessions WHERE id = $sessionId`),
  };

  /**
   * Mirrors the resolveSessionId logic from db.js (without the git-root path).
   */
  function resolveSessionId(claudeSessionId, projectDir) {
    const existing = stmts.getAlias.get({ $claudeSessionId: claudeSessionId });
    if (existing) return existing.dashboard_session_id;

    if (projectDir && projectDir !== "unknown") {
      const active = stmts.findActiveSessionByDir.get({ $projectDir: projectDir });
      if (active) {
        stmts.insertAlias.run({ $claudeSessionId: claudeSessionId, $dashboardSessionId: active.id });
        return active.id;
      }

      const recent = stmts.findRecentSessionByDir.get({ $projectDir: projectDir });
      if (recent) {
        stmts.insertAlias.run({ $claudeSessionId: claudeSessionId, $dashboardSessionId: recent.id });
        return recent.id;
      }
    }

    stmts.insertAlias.run({ $claudeSessionId: claudeSessionId, $dashboardSessionId: claudeSessionId });
    return claudeSessionId;
  }

  function lookupSessionId(claudeSessionId) {
    const existing = stmts.getAlias.get({ $claudeSessionId: claudeSessionId });
    return existing ? existing.dashboard_session_id : claudeSessionId;
  }

  function deleteSession(sessionId) {
    const session = stmts.getSession.get({ $id: sessionId });
    if (!session) return false;
    if (session.status === "active") return false;

    db.transaction(() => {
      stmts.deleteSessionWorktrees.run({ $sessionId: sessionId });
      stmts.deleteSessionAgents.run({ $sessionId: sessionId });
      stmts.deleteSessionEvents.run({ $sessionId: sessionId });
      stmts.deleteSessionAliases.run({ $sessionId: sessionId });
      stmts.deleteSessionRow.run({ $sessionId: sessionId });
    })();

    return true;
  }

  return { db, ...stmts, resolveSessionId, lookupSessionId, deleteSession };
}

// ─── resolveSessionId ────────────────────────────────────────────────────────

describe("resolveSessionId", () => {
  let t;
  beforeEach(() => { t = createTestDb(); });

  it("returns the claude session id for a new session", () => {
    const id = t.resolveSessionId("cli-1", "/project/a");
    expect(id).toBe("cli-1");
  });

  it("creates an alias for new sessions", () => {
    t.resolveSessionId("cli-1", "/project/a");
    const alias = t.getAlias.get({ $claudeSessionId: "cli-1" });
    expect(alias.dashboard_session_id).toBe("cli-1");
  });

  it("returns existing alias if already mapped", () => {
    t.insertAlias.run({ $claudeSessionId: "cli-1", $dashboardSessionId: "dash-1" });
    const id = t.resolveSessionId("cli-1", "/project/a");
    expect(id).toBe("dash-1");
  });

  it("aliases to active session with same project dir", () => {
    // Create an active session for /project/a
    t.upsertSession.run({
      $id: "dash-1",
      $projectDir: "/project/a",
      $worktreeDir: null,
      $status: "active",
      $model: null,
      $currentClaudeSessionId: null,
    });

    // New CLI session for same dir should alias to it
    const id = t.resolveSessionId("cli-2", "/project/a");
    expect(id).toBe("dash-1");
  });

  it("does not alias to stopped sessions via the active path", () => {
    t.upsertSession.run({
      $id: "dash-1",
      $projectDir: "/project/a",
      $worktreeDir: null,
      $status: "stopped",
      $model: null,
      $currentClaudeSessionId: null,
    });

    // Stopped session — recent query may match since last_seen_at is 'now',
    // but the active path should not match
    const id = t.resolveSessionId("cli-2", "/project/a");
    // Should still resolve (via recent path since last_seen_at is recent)
    expect(id).toBe("dash-1");
  });

  it("creates new session for different project dir", () => {
    t.upsertSession.run({
      $id: "dash-1",
      $projectDir: "/project/a",
      $worktreeDir: null,
      $status: "active",
      $model: null,
      $currentClaudeSessionId: null,
    });

    const id = t.resolveSessionId("cli-2", "/project/b");
    expect(id).toBe("cli-2");
    expect(id).not.toBe("dash-1");
  });

  it("creates new session for 'unknown' project dir", () => {
    t.upsertSession.run({
      $id: "dash-1",
      $projectDir: "/project/a",
      $worktreeDir: null,
      $status: "active",
      $model: null,
      $currentClaudeSessionId: null,
    });

    const id = t.resolveSessionId("cli-2", "unknown");
    expect(id).toBe("cli-2");
  });

  it("creates new session for null project dir", () => {
    const id = t.resolveSessionId("cli-1", null);
    expect(id).toBe("cli-1");
  });

  it("multiple CLI sessions alias to the same dashboard session", () => {
    t.upsertSession.run({
      $id: "dash-1",
      $projectDir: "/project/a",
      $worktreeDir: null,
      $status: "active",
      $model: null,
      $currentClaudeSessionId: null,
    });

    const id1 = t.resolveSessionId("cli-2", "/project/a");
    const id2 = t.resolveSessionId("cli-3", "/project/a");
    expect(id1).toBe("dash-1");
    expect(id2).toBe("dash-1");
  });

  it("idempotent: resolving the same CLI id twice returns the same result", () => {
    const id1 = t.resolveSessionId("cli-1", "/project/a");
    const id2 = t.resolveSessionId("cli-1", "/project/a");
    expect(id1).toBe(id2);
  });
});

// ─── lookupSessionId ─────────────────────────────────────────────────────────

describe("lookupSessionId", () => {
  let t;
  beforeEach(() => { t = createTestDb(); });

  it("returns the aliased dashboard id if mapped", () => {
    t.insertAlias.run({ $claudeSessionId: "cli-1", $dashboardSessionId: "dash-1" });
    expect(t.lookupSessionId("cli-1")).toBe("dash-1");
  });

  it("falls back to the input id if no alias exists", () => {
    expect(t.lookupSessionId("no-such-id")).toBe("no-such-id");
  });

  it("does not create an alias (read-only)", () => {
    t.lookupSessionId("cli-1");
    const alias = t.getAlias.get({ $claudeSessionId: "cli-1" });
    expect(alias).toBeNull();
  });
});

// ─── deleteSession ───────────────────────────────────────────────────────────

describe("deleteSession", () => {
  let t;
  beforeEach(() => { t = createTestDb(); });

  it("returns false for non-existent session", () => {
    expect(t.deleteSession("nonexistent")).toBe(false);
  });

  it("returns false for active session", () => {
    t.upsertSession.run({
      $id: "s1",
      $projectDir: "/project/a",
      $worktreeDir: null,
      $status: "active",
      $model: null,
      $currentClaudeSessionId: null,
    });
    expect(t.deleteSession("s1")).toBe(false);
    // Session should still exist
    expect(t.getSession.get({ $id: "s1" })).toBeTruthy();
  });

  it("deletes a stopped session", () => {
    t.upsertSession.run({
      $id: "s1",
      $projectDir: "/project/a",
      $worktreeDir: null,
      $status: "stopped",
      $model: null,
      $currentClaudeSessionId: null,
    });
    expect(t.deleteSession("s1")).toBe(true);
    expect(t.getSession.get({ $id: "s1" })).toBeNull();
  });

  it("cascade-deletes events", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: null,
      $status: "stopped", $model: null, $currentClaudeSessionId: null,
    });
    t.insertEvent.get({
      $sessionId: "s1", $type: "tool_use", $toolName: "Read",
      $filePath: null, $summary: null, $payload: null,
    });
    expect(t.getSessionEvents.all({ $sessionId: "s1" })).toHaveLength(1);

    t.deleteSession("s1");
    expect(t.getSessionEvents.all({ $sessionId: "s1" })).toHaveLength(0);
  });

  it("cascade-deletes agents", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: null,
      $status: "stopped", $model: null, $currentClaudeSessionId: null,
    });
    const { id: eventId } = t.insertEvent.get({
      $sessionId: "s1", $type: "tool_use", $toolName: "Agent",
      $filePath: null, $summary: null, $payload: null,
    });
    t.insertAgent.get({
      $sessionId: "s1", $eventId: eventId, $description: "test",
      $agentType: "general-purpose", $prompt: "do stuff", $status: "completed",
    });
    expect(t.getSessionAgents.all({ $sessionId: "s1" })).toHaveLength(1);

    t.deleteSession("s1");
    expect(t.getSessionAgents.all({ $sessionId: "s1" })).toHaveLength(0);
  });

  it("cascade-deletes worktrees", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: null,
      $status: "stopped", $model: null, $currentClaudeSessionId: null,
    });
    t.insertWorktree.get({
      $sessionId: "s1", $branchName: "agent/test-abc123",
      $baseBranch: "main", $description: "test", $agentId: null, $status: "ready",
    });
    expect(t.getSessionWorktrees.all({ $sessionId: "s1" })).toHaveLength(1);

    t.deleteSession("s1");
    expect(t.getSessionWorktrees.all({ $sessionId: "s1" })).toHaveLength(0);
  });

  it("cascade-deletes aliases", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: null,
      $status: "stopped", $model: null, $currentClaudeSessionId: null,
    });
    t.insertAlias.run({ $claudeSessionId: "cli-1", $dashboardSessionId: "s1" });
    t.insertAlias.run({ $claudeSessionId: "cli-2", $dashboardSessionId: "s1" });

    t.deleteSession("s1");
    expect(t.getAlias.get({ $claudeSessionId: "cli-1" })).toBeNull();
    expect(t.getAlias.get({ $claudeSessionId: "cli-2" })).toBeNull();
  });

  it("deletes error-status session", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: null,
      $status: "error", $model: null, $currentClaudeSessionId: null,
    });
    expect(t.deleteSession("s1")).toBe(true);
  });
});

// ─── upsertSession edge cases ────────────────────────────────────────────────

describe("upsertSession", () => {
  let t;
  beforeEach(() => { t = createTestDb(); });

  it("preserves model on null update", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: null,
      $status: "active", $model: "opus-4", $currentClaudeSessionId: null,
    });
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    const session = t.getSession.get({ $id: "s1" });
    expect(session.model).toBe("opus-4");
  });

  it("updates model when new value is provided", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: null,
      $status: "active", $model: "opus-4", $currentClaudeSessionId: null,
    });
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: null,
      $status: "active", $model: "sonnet-4", $currentClaudeSessionId: null,
    });
    const session = t.getSession.get({ $id: "s1" });
    expect(session.model).toBe("sonnet-4");
  });

  it("does not overwrite project_dir with 'unknown'", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/real/path", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    t.upsertSession.run({
      $id: "s1", $projectDir: "unknown", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    const session = t.getSession.get({ $id: "s1" });
    expect(session.project_dir).toBe("/real/path");
  });

  it("upgrades project_dir from 'unknown' to real path", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "unknown", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    t.upsertSession.run({
      $id: "s1", $projectDir: "/real/path", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    const session = t.getSession.get({ $id: "s1" });
    expect(session.project_dir).toBe("/real/path");
  });

  it("preserves worktree_dir on null update", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: "/wt",
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    const session = t.getSession.get({ $id: "s1" });
    expect(session.worktree_dir).toBe("/wt");
  });

  it("preserves current_claude_session_id on null update", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: "real-cli-id",
    });
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    const session = t.getSession.get({ $id: "s1" });
    expect(session.current_claude_session_id).toBe("real-cli-id");
  });
});

// ─── Worktree unique constraint ──────────────────────────────────────────────

describe("worktree constraints", () => {
  let t;
  beforeEach(() => { t = createTestDb(); });

  it("upserts on duplicate (session_id, branch_name)", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });

    t.insertWorktree.get({
      $sessionId: "s1", $branchName: "agent/test",
      $baseBranch: "main", $description: "first", $agentId: null, $status: "pending",
    });

    // Insert again with same branch — should update, not error
    t.insertWorktree.get({
      $sessionId: "s1", $branchName: "agent/test",
      $baseBranch: "main", $description: "updated", $agentId: null, $status: "ready",
    });

    const wts = t.getSessionWorktrees.all({ $sessionId: "s1" });
    expect(wts).toHaveLength(1);
    expect(wts[0].description).toBe("updated");
    expect(wts[0].status).toBe("ready");
  });

  it("allows same branch name for different sessions", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p1", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    t.upsertSession.run({
      $id: "s2", $projectDir: "/p2", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });

    t.insertWorktree.get({
      $sessionId: "s1", $branchName: "agent/test",
      $baseBranch: "main", $description: "s1", $agentId: null, $status: "pending",
    });
    t.insertWorktree.get({
      $sessionId: "s2", $branchName: "agent/test",
      $baseBranch: "main", $description: "s2", $agentId: null, $status: "pending",
    });

    expect(t.getSessionWorktrees.all({ $sessionId: "s1" })).toHaveLength(1);
    expect(t.getSessionWorktrees.all({ $sessionId: "s2" })).toHaveLength(1);
  });
});

// ─── worktree_dir __clear__ sentinel ──────────────────────────────────────────

describe("upsertSession worktree_dir clearing", () => {
  let t;
  beforeEach(() => { t = createTestDb(); });

  it("clears worktree_dir when __clear__ sentinel is passed", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/project/root", $worktreeDir: "/stale/worktree",
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    expect(t.getSession.get({ $id: "s1" }).worktree_dir).toBe("/stale/worktree");

    t.upsertSession.run({
      $id: "s1", $projectDir: "/project/root", $worktreeDir: "__clear__",
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    expect(t.getSession.get({ $id: "s1" }).worktree_dir).toBeNull();
  });

  it("preserves worktree_dir when null is passed (COALESCE behavior)", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: "/existing/wt",
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    expect(t.getSession.get({ $id: "s1" }).worktree_dir).toBe("/existing/wt");
  });

  it("sets worktree_dir when a real path is passed", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: "/new/worktree",
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    expect(t.getSession.get({ $id: "s1" }).worktree_dir).toBe("/new/worktree");
  });

  it("can re-set worktree_dir after clearing", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: "/old",
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    // Clear
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: "__clear__",
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    expect(t.getSession.get({ $id: "s1" }).worktree_dir).toBeNull();

    // Re-set
    t.upsertSession.run({
      $id: "s1", $projectDir: "/p", $worktreeDir: "/new",
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    expect(t.getSession.get({ $id: "s1" }).worktree_dir).toBe("/new");
  });
});
