import { afterEach, describe, expect, it } from "bun:test";

/**
 * SQLite adapter tests for session operations.
 *
 * Imports directly from db-sqlite/sessions.js (not db-adapter.js) to test the
 * SQLite layer in isolation. Uses the real bun:sqlite database (respects
 * DASHBOARD_DB_PATH) with unique IDs per test and cleanup in afterEach.
 *
 * These tests run without any external dependencies — no Supabase connection
 * required.
 */

import {
  upsertSession,
  getSession,
  updateSessionClaudeId,
  updateSessionStatus,
  updateSessionGitRoot,
  touchSessionActive,
  deleteSession,
  getAllSessions,
  getActiveSessions,
  findActiveSessionByDir,
  findRecentSessionByDir,
  findActiveSessionByGitRoot,
  findRecentSessionByGitRoot,
} from "./sessions.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

let seq = 0;
function uid(prefix = "s") {
  return `${prefix}-sqlite-test-${Date.now()}-${++seq}`;
}

async function makeSession(overrides = {}) {
  const id = overrides.id ?? uid("sess");
  const projectDir = overrides.projectDir ?? `/tmp/test-project-${id}`;
  await upsertSession({
    id,
    projectDir,
    status: "active",
    ...overrides,
  });
  return { id, projectDir };
}

const createdIds = [];

afterEach(async () => {
  for (const id of createdIds.splice(0)) {
    try { await deleteSession(id); } catch { /* ignore */ }
  }
});

function track(id) {
  createdIds.push(id);
  return id;
}

// ─── upsertSession / getSession ───────────────────────────────────────────────

describe("upsertSession / getSession", () => {
  it("creates a new session and retrieves it", async () => {
    const { id, projectDir } = await makeSession();
    track(id);
    const row = await getSession(id);
    expect(row).not.toBeNull();
    expect(row.id).toBe(id);
    expect(row.project_dir).toBe(projectDir);
    expect(row.status).toBe("active");
  });

  it("returns null for an unknown session id", async () => {
    const row = await getSession("nonexistent-session-id");
    expect(row).toBeNull();
  });

  it("upserts — updates status on re-insert (project_dir is immutable after creation)", async () => {
    const { id, projectDir } = await makeSession({ status: "active" });
    track(id);
    await upsertSession({ id, projectDir, status: "stopped" });
    const row = await getSession(id);
    expect(row.status).toBe("stopped");
    // ON CONFLICT only updates status/model/last_seen_at — project_dir stays
    expect(row.project_dir).toBe(projectDir);
  });

  it("stores optional fields as null when omitted", async () => {
    const { id } = await makeSession();
    track(id);
    const row = await getSession(id);
    expect(row.model).toBeNull();
    expect(row.current_claude_session_id).toBeNull();
    expect(row.git_root).toBeNull();
  });
});

// ─── updateSessionClaudeId ────────────────────────────────────────────────────

describe("updateSessionClaudeId", () => {
  it("persists a claude session ID on an existing session", async () => {
    const { id } = await makeSession();
    track(id);
    const claudeId = `claude-sdk-${uid("c")}`;
    await updateSessionClaudeId(id, claudeId);
    const row = await getSession(id);
    expect(row.current_claude_session_id).toBe(claudeId);
  });

  it("overwrites a previously set claude session ID", async () => {
    const { id } = await makeSession({ currentClaudeSessionId: "old-id" });
    track(id);
    await updateSessionClaudeId(id, "new-id");
    const row = await getSession(id);
    expect(row.current_claude_session_id).toBe("new-id");
  });

  it("does not affect other session fields", async () => {
    const projectDir = `/tmp/claude-id-test-${uid()}`;
    const { id } = await makeSession({ projectDir, status: "active" });
    track(id);
    await updateSessionClaudeId(id, "sdk-xyz");
    const row = await getSession(id);
    expect(row.project_dir).toBe(projectDir);
    expect(row.status).toBe("active");
  });

  it("is a no-op for a nonexistent session id (no error thrown)", async () => {
    // resolves without throwing — bun:sqlite returns {changes:0} for no-match UPDATE
    const result = await updateSessionClaudeId("ghost-id", "sdk-abc");
    expect(result).toBeDefined();
  });
});

// ─── updateSessionStatus ─────────────────────────────────────────────────────

describe("updateSessionStatus", () => {
  it("updates status from active to stopped", async () => {
    const { id } = await makeSession({ status: "active" });
    track(id);
    await updateSessionStatus(id, "stopped");
    expect((await getSession(id)).status).toBe("stopped");
  });
});

// ─── updateSessionGitRoot ─────────────────────────────────────────────────────

describe("updateSessionGitRoot", () => {
  it("sets a git root path", async () => {
    const { id } = await makeSession();
    track(id);
    const gitRoot = `/tmp/repo-${uid()}`;
    await updateSessionGitRoot(id, gitRoot);
    expect((await getSession(id)).git_root).toBe(gitRoot);
  });

  it("preserves existing git root when null is passed (COALESCE behaviour)", async () => {
    const gitRoot = `/tmp/repo-${uid()}`;
    const { id } = await makeSession({ gitRoot });
    track(id);
    // COALESCE($gitRoot, git_root) — null arg keeps the current value
    await updateSessionGitRoot(id, null);
    expect((await getSession(id)).git_root).toBe(gitRoot);
  });
});

// ─── touchSessionActive ───────────────────────────────────────────────────────

describe("touchSessionActive", () => {
  it("marks session as active and updates last_seen_at", async () => {
    const { id } = await makeSession({ status: "stopped" });
    track(id);
    const result = await touchSessionActive(id);
    expect(result).toBeDefined();
    expect((await getSession(id)).status).toBe("active");
  });
});

// ─── getActiveSessions / getAllSessions ───────────────────────────────────────

describe("getActiveSessions", () => {
  it("includes active sessions", async () => {
    const { id } = await makeSession({ status: "active" });
    track(id);
    const active = await getActiveSessions();
    expect(active.some((s) => s.id === id)).toBe(true);
  });

  it("excludes stopped sessions", async () => {
    const { id } = await makeSession({ status: "stopped" });
    track(id);
    const active = await getActiveSessions();
    expect(active.some((s) => s.id === id)).toBe(false);
  });
});

describe("getAllSessions", () => {
  it("includes both active and stopped sessions", async () => {
    const { id: aid } = await makeSession({ status: "active" });
    const { id: sid } = await makeSession({ status: "stopped" });
    track(aid);
    track(sid);
    const all = await getAllSessions();
    expect(all.some((s) => s.id === aid)).toBe(true);
    expect(all.some((s) => s.id === sid)).toBe(true);
  });
});

// ─── findActiveSessionByDir / findRecentSessionByDir ─────────────────────────

describe("findActiveSessionByDir", () => {
  it("finds an active session by project directory", async () => {
    const projectDir = `/tmp/find-dir-${uid()}`;
    const { id } = await makeSession({ projectDir, status: "active" });
    track(id);
    const found = await findActiveSessionByDir(projectDir);
    expect(found).not.toBeNull();
    expect(found.id).toBe(id);
  });

  it("returns null when only a stopped session exists for the dir", async () => {
    const projectDir = `/tmp/stopped-dir-${uid()}`;
    const { id } = await makeSession({ projectDir, status: "stopped" });
    track(id);
    const found = await findActiveSessionByDir(projectDir);
    expect(found).toBeNull();
  });
});

describe("findRecentSessionByDir", () => {
  it("finds a recently active session by project dir (within 30 min window)", async () => {
    // SQL filters: status='active' AND last_seen_at >= now-30min
    const projectDir = `/tmp/recent-dir-${uid()}`;
    const { id } = await makeSession({ projectDir, status: "active" });
    track(id);
    // Touch to ensure last_seen_at is within the 30-minute window
    await touchSessionActive(id);
    const found = await findRecentSessionByDir(projectDir);
    expect(found).not.toBeNull();
    expect(found.id).toBe(id);
  });

  it("returns null for an inactive session (stopped)", async () => {
    const projectDir = `/tmp/recent-stopped-${uid()}`;
    const { id } = await makeSession({ projectDir, status: "stopped" });
    track(id);
    expect(await findRecentSessionByDir(projectDir)).toBeNull();
  });
});

// ─── findActiveSessionByGitRoot / findRecentSessionByGitRoot ─────────────────

describe("findActiveSessionByGitRoot / findRecentSessionByGitRoot", () => {
  it("finds active session by git root", async () => {
    const gitRoot = `/tmp/repo-${uid()}`;
    const { id } = await makeSession({ gitRoot, status: "active" });
    track(id);
    const found = await findActiveSessionByGitRoot(gitRoot);
    expect(found?.id).toBe(id);
  });

  it("finds a recently active session by git root (within 30 min window)", async () => {
    // SQL filters: status='active' AND last_seen_at >= now-30min
    const gitRoot = `/tmp/repo-recent-${uid()}`;
    const { id } = await makeSession({ gitRoot, status: "active" });
    track(id);
    await touchSessionActive(id);
    const found = await findRecentSessionByGitRoot(gitRoot);
    expect(found?.id).toBe(id);
  });

  it("returns null when no session matches git root", async () => {
    const found = await findActiveSessionByGitRoot("/nonexistent/repo");
    expect(found).toBeNull();
  });
});
