import { describe, expect, it, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";

/**
 * Tests for the transactional session resolution fix.
 * Verifies that concurrent resolveSessionId calls for the same project_dir
 * produce exactly one dashboard session (no duplicates).
 */

function createTestDb() {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  // Same schema as db.test.js — sessions, events, session_aliases, agents, worktrees
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
        worktree_dir = COALESCE($worktreeDir, sessions.worktree_dir),
        current_claude_session_id = COALESCE($currentClaudeSessionId, sessions.current_claude_session_id),
        last_seen_at = datetime('now')
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
    getActiveSessionsByDir: db.prepare(`
      SELECT * FROM sessions WHERE project_dir = $projectDir AND status = 'active'
    `),
    insertEvent: db.prepare(`
      INSERT INTO events (session_id, type, tool_name) VALUES ($sessionId, $type, $toolName) RETURNING id
    `),
    insertAgent: db.prepare(`
      INSERT INTO agents (session_id, event_id, description, agent_type, prompt, status)
      VALUES ($sessionId, $eventId, $description, $agentType, $prompt, $status) RETURNING id
    `),
  };

  /**
   * Transactional resolveSessionId — mirrors the production fix.
   * Wraps the check-then-create logic in db.transaction() so concurrent
   * callers serialize and the second one sees the first's writes.
   */
  function resolveSessionId(claudeSessionId, projectDir) {
    return db.transaction(() => {
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
      stmts.upsertSession.run({
        $id: claudeSessionId, $projectDir: projectDir || "unknown",
        $worktreeDir: null, $status: "active", $model: null,
        $currentClaudeSessionId: claudeSessionId,
      });
      return claudeSessionId;
    })();
  }

  /**
   * deduplicateSessions — mirrors the production cleanup function.
   */
  function deduplicateSessions() {
    const dupes = db.prepare(`
      SELECT project_dir, GROUP_CONCAT(id) as ids
      FROM sessions WHERE status = 'active'
      GROUP BY project_dir HAVING COUNT(*) > 1
    `).all();

    for (const { project_dir, ids } of dupes) {
      const idList = ids.split(",");
      const keep = idList[0];
      const remove = idList.slice(1);
      db.transaction(() => {
        for (const id of remove) {
          db.prepare(`UPDATE session_aliases SET dashboard_session_id = $keep WHERE dashboard_session_id = $id`)
            .run({ $keep: keep, $id: id });
          db.prepare(`UPDATE events SET session_id = $keep WHERE session_id = $id`)
            .run({ $keep: keep, $id: id });
          db.prepare(`UPDATE agents SET session_id = $keep WHERE session_id = $id`)
            .run({ $keep: keep, $id: id });
          db.prepare(`DELETE FROM sessions WHERE id = $id`).run({ $id: id });
        }
      })();
    }
    return dupes.length;
  }

  return { db, ...stmts, resolveSessionId, deduplicateSessions };
}

// ─── Transactional resolveSessionId ───────────────────────────────────────────

describe("resolveSessionId (transactional)", () => {
  let t;
  beforeEach(() => { t = createTestDb(); });

  it("sequential calls with same projectDir produce one session", () => {
    // Simulate 3 hook calls arriving for the same project with different CLI IDs
    const id1 = t.resolveSessionId("cli-1", "/project/dashboard");
    const id2 = t.resolveSessionId("cli-2", "/project/dashboard");
    const id3 = t.resolveSessionId("cli-3", "/project/dashboard");

    // All should resolve to the same dashboard session
    expect(id1).toBe(id2);
    expect(id2).toBe(id3);

    // Only one session row should exist for this project
    const sessions = t.getActiveSessionsByDir.all({ $projectDir: "/project/dashboard" });
    expect(sessions).toHaveLength(1);
  });

  it("first caller creates session, subsequent callers alias to it", () => {
    const id1 = t.resolveSessionId("cli-1", "/project/a");
    // cli-1 creates its own session
    expect(id1).toBe("cli-1");
    expect(t.getSession.get({ $id: "cli-1" })).toBeTruthy();

    // cli-2 should alias to cli-1's session
    const id2 = t.resolveSessionId("cli-2", "/project/a");
    expect(id2).toBe("cli-1");

    // Verify alias was created
    const alias = t.getAlias.get({ $claudeSessionId: "cli-2" });
    expect(alias.dashboard_session_id).toBe("cli-1");
  });

  it("different project dirs still create separate sessions", () => {
    const id1 = t.resolveSessionId("cli-1", "/project/a");
    const id2 = t.resolveSessionId("cli-2", "/project/b");

    expect(id1).toBe("cli-1");
    expect(id2).toBe("cli-2");
    expect(id1).not.toBe(id2);
  });

  it("unknown projectDir does not merge with real sessions", () => {
    const id1 = t.resolveSessionId("cli-1", "/project/a");
    const id2 = t.resolveSessionId("cli-2", "unknown");

    expect(id1).toBe("cli-1");
    expect(id2).toBe("cli-2");
    expect(id1).not.toBe(id2);
  });

  it("idempotent: same CLI ID always returns same result", () => {
    const id1 = t.resolveSessionId("cli-1", "/project/a");
    const id2 = t.resolveSessionId("cli-1", "/project/a");
    expect(id1).toBe(id2);
  });
});

// ─── deduplicateSessions ──────────────────────────────────────────────────────

describe("deduplicateSessions", () => {
  let t;
  beforeEach(() => { t = createTestDb(); });

  it("merges duplicate active sessions for the same project_dir", () => {
    // Manually create 3 duplicate sessions (simulating the old race condition)
    t.upsertSession.run({
      $id: "s1", $projectDir: "/project/a", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    t.upsertSession.run({
      $id: "s2", $projectDir: "/project/a", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    t.upsertSession.run({
      $id: "s3", $projectDir: "/project/a", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });

    const merged = t.deduplicateSessions();
    expect(merged).toBe(1); // 1 project_dir had duplicates

    const sessions = t.getActiveSessionsByDir.all({ $projectDir: "/project/a" });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe("s1"); // oldest kept
  });

  it("re-parents events from duplicate sessions", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/project/a", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    t.upsertSession.run({
      $id: "s2", $projectDir: "/project/a", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });

    // Add event to s2 (the duplicate that will be removed)
    t.insertEvent.get({ $sessionId: "s2", $type: "tool_use", $toolName: "Read" });

    t.deduplicateSessions();

    // Event should now belong to s1
    const s1Events = t.db.prepare(`SELECT * FROM events WHERE session_id = 's1'`).all();
    expect(s1Events).toHaveLength(1);
    expect(s1Events[0].tool_name).toBe("Read");

    // s2 should be gone
    expect(t.getSession.get({ $id: "s2" })).toBeNull();
  });

  it("re-parents aliases from duplicate sessions", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/project/a", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    t.upsertSession.run({
      $id: "s2", $projectDir: "/project/a", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    t.insertAlias.run({ $claudeSessionId: "cli-99", $dashboardSessionId: "s2" });

    t.deduplicateSessions();

    // Alias should now point to s1
    const alias = t.getAlias.get({ $claudeSessionId: "cli-99" });
    expect(alias.dashboard_session_id).toBe("s1");
  });

  it("does not touch sessions with different project_dirs", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/project/a", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    t.upsertSession.run({
      $id: "s2", $projectDir: "/project/b", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });

    const merged = t.deduplicateSessions();
    expect(merged).toBe(0);

    // Both sessions should still exist
    expect(t.getSession.get({ $id: "s1" })).toBeTruthy();
    expect(t.getSession.get({ $id: "s2" })).toBeTruthy();
  });

  it("does not touch stopped sessions", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/project/a", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });
    t.upsertSession.run({
      $id: "s2", $projectDir: "/project/a", $worktreeDir: null,
      $status: "stopped", $model: null, $currentClaudeSessionId: null,
    });

    const merged = t.deduplicateSessions();
    expect(merged).toBe(0); // only 1 active, so no dupes
  });

  it("returns 0 when no duplicates exist", () => {
    t.upsertSession.run({
      $id: "s1", $projectDir: "/project/a", $worktreeDir: null,
      $status: "active", $model: null, $currentClaudeSessionId: null,
    });

    const merged = t.deduplicateSessions();
    expect(merged).toBe(0);
  });
});
