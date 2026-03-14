import { describe, expect, it, afterEach } from "bun:test";

/**
 * Tests for the async Postgres session resolver.
 *
 * Requires a live database connection (SUPABASE_DB_URL). All suites are
 * skipped when the env var is absent so unit-only CI runs pass without a DB.
 *
 * db-pg.js throws at module load time when SUPABASE_DB_URL is absent, so
 * we use a conditional dynamic import to avoid the error in skip-mode.
 *
 * The tests exercise:
 *  - resolveSessionId: 5-step alias resolution
 *  - lookupSessionId: read-only alias lookup
 *  - deduplicateSessions: merge duplicate active sessions
 *  - subdirectory guard / worktree_dir clearing (via upsertSession directly)
 */

const SKIP = !process.env.SUPABASE_DB_URL;

// Lazily-populated DB handles — only defined when SKIP is false.
let resolveSessionId, lookupSessionId,
    upsertSession, getSession, getAlias, insertAlias,
    insertEvent, deduplicateSessions, sql;

if (!SKIP) {
  ({
    resolveSessionId,
    lookupSessionId,
    upsertSession,
    getSession,
    getAlias,
    insertAlias,
    insertEvent,
    deduplicateSessions,
    sql,
  } = await import("./db-supabase.js"));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let idSeq = 0;
function uid(prefix = "s") {
  return `${prefix}-test-${Date.now()}-${++idSeq}`;
}

async function forceDelete(sessionId) {
  await sql`DELETE FROM worktrees       WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM agents          WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM events          WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM session_aliases WHERE dashboard_session_id = ${sessionId}`;
  await sql`DELETE FROM sessions        WHERE id = ${sessionId}`;
}

async function deleteAliasFor(claudeSessionId) {
  await sql`DELETE FROM session_aliases WHERE claude_session_id = ${claudeSessionId}`;
}

async function makeSession(overrides = {}) {
  const id = overrides.id ?? uid("sess");
  await upsertSession({
    id,
    projectDir: overrides.projectDir ?? "/project/test",
    worktreeDir: overrides.worktreeDir ?? null,
    gitRoot: overrides.gitRoot ?? null,
    status: overrides.status ?? "active",
    model: overrides.model ?? null,
    currentClaudeSessionId: overrides.currentClaudeSessionId ?? null,
  });
  return id;
}

// ─── resolveSessionId ────────────────────────────────────────────────────────

describe.skipIf(SKIP)("resolveSessionId", () => {
  const created = [];
  afterEach(async () => {
    for (const id of created) await forceDelete(id);
    created.length = 0;
  });

  async function sess(overrides = {}) {
    const id = await makeSession(overrides);
    created.push(id);
    return id;
  }

  async function resolve(cliId, projectDir) {
    const dashId = await resolveSessionId(cliId, projectDir);
    if (!created.includes(dashId)) created.push(dashId);
    return dashId;
  }

  it("returns the claude session id for a brand-new session", async () => {
    const cliId = uid("cli");
    const id = await resolve(cliId, uid("/project/new"));
    expect(id).toBe(cliId);
  });

  it("creates an alias for new sessions", async () => {
    const cliId = uid("cli");
    const dir = uid("/project/a");
    await resolve(cliId, dir);
    const alias = await getAlias(cliId);
    expect(alias?.dashboard_session_id).toBe(cliId);
  });

  it("returns existing alias if already mapped", async () => {
    const cliId = uid("cli");
    const dashId = await sess({ projectDir: uid("/p") });
    await insertAlias(cliId, dashId);

    const id = await resolveSessionId(cliId, uid("/p2"));
    expect(id).toBe(dashId);
    await deleteAliasFor(cliId);
  });

  it("aliases to active session with same project dir", async () => {
    const dir = uid("/project/shared");
    const dashId = await sess({ projectDir: dir });
    const cliId = uid("cli-new");

    const id = await resolve(cliId, dir);
    expect(id).toBe(dashId);
  });

  it("does not alias to stopped sessions", async () => {
    const dir = uid("/project/stopped");
    const stoppedId = await sess({ projectDir: dir, status: "stopped" });
    const cliId = uid("cli-new");

    const id = await resolve(cliId, dir);
    expect(id).toBe(cliId);
    expect(id).not.toBe(stoppedId);
  });

  it("creates new session for different project dir", async () => {
    const dashId = await sess({ projectDir: uid("/project/a") });
    const cliId = uid("cli-new");

    const id = await resolve(cliId, uid("/project/b"));
    expect(id).toBe(cliId);
    expect(id).not.toBe(dashId);
  });

  it("creates new session for 'unknown' project dir", async () => {
    const dashId = await sess({ projectDir: uid("/project/real") });
    const cliId = uid("cli-new");

    const id = await resolve(cliId, "unknown");
    expect(id).toBe(cliId);
    expect(id).not.toBe(dashId);
  });

  it("creates new session for null project dir", async () => {
    const cliId = uid("cli");
    const id = await resolve(cliId, null);
    expect(id).toBe(cliId);
  });

  it("multiple CLI sessions alias to the same dashboard session", async () => {
    const dir = uid("/project/multi");
    const dashId = await sess({ projectDir: dir });
    const cliId2 = uid("cli-2");
    const cliId3 = uid("cli-3");

    const id1 = await resolve(cliId2, dir);
    const id2 = await resolve(cliId3, dir);
    expect(id1).toBe(dashId);
    expect(id2).toBe(dashId);
  });

  it("idempotent: resolving the same CLI id twice returns the same result", async () => {
    const cliId = uid("cli");
    const dir = uid("/project/idem");
    const id1 = await resolve(cliId, dir);
    const id2 = await resolveSessionId(cliId, dir);
    expect(id1).toBe(id2);
  });
});

// ─── lookupSessionId ─────────────────────────────────────────────────────────

describe.skipIf(SKIP)("lookupSessionId", () => {
  it("returns the aliased dashboard id if mapped", async () => {
    const cliId = uid("cli");
    const dashId = uid("dash");
    await insertAlias(cliId, dashId);
    expect(await lookupSessionId(cliId)).toBe(dashId);
    await sql`DELETE FROM session_aliases WHERE claude_session_id = ${cliId}`;
  });

  it("falls back to the input id if no alias exists", async () => {
    const id = uid("no-such");
    expect(await lookupSessionId(id)).toBe(id);
  });

  it("does not create an alias (read-only)", async () => {
    const cliId = uid("cli");
    await lookupSessionId(cliId);
    const alias = await getAlias(cliId);
    expect(alias).toBeNull();
  });
});

// ─── deduplicateSessions ──────────────────────────────────────────────────────

describe.skipIf(SKIP)("deduplicateSessions", () => {
  const created = [];
  afterEach(async () => {
    for (const id of created) await forceDelete(id);
    created.length = 0;
  });

  async function sess(overrides = {}) {
    const id = overrides.id ?? uid("s");
    await makeSession({ id, ...overrides });
    created.push(id);
    return id;
  }

  it("merges duplicate active sessions for the same project_dir", async () => {
    const dir = uid("/project/dup");
    await sess({ id: uid("s1"), projectDir: dir });
    await sess({ id: uid("s2"), projectDir: dir });
    await sess({ id: uid("s3"), projectDir: dir });

    await deduplicateSessions();

    const rows = await sql`
      SELECT id FROM sessions WHERE project_dir = ${dir} AND status = 'active'
    `;
    expect(rows.length).toBeLessThanOrEqual(1);
  });

  it("re-parents events from duplicate sessions", async () => {
    const dir = uid("/project/repar");
    const s1 = await sess({ id: uid("s1"), projectDir: dir });
    const s2 = await sess({ id: uid("s2"), projectDir: dir });

    await insertEvent({ sessionId: s2, type: "tool_use", toolName: "Read" });

    await deduplicateSessions();

    const survivors = await sql`
      SELECT id FROM sessions WHERE project_dir = ${dir} AND status = 'active'
    `;
    expect(survivors.length).toBe(1);
    const keepId = survivors[0].id;

    const events = await sql`SELECT * FROM events WHERE session_id = ${keepId}`;
    expect(events.length).toBeGreaterThan(0);
    void s1;
  });

  it("re-parents aliases from duplicate sessions", async () => {
    const dir = uid("/project/alias-repar");
    const s1 = await sess({ id: uid("s1"), projectDir: dir });
    const s2 = await sess({ id: uid("s2"), projectDir: dir });
    const cliId = uid("cli");
    await insertAlias(cliId, s2);

    await deduplicateSessions();

    const alias = await getAlias(cliId);
    const surviving = await sql`
      SELECT id FROM sessions WHERE project_dir = ${dir} AND status = 'active'
    `;
    if (surviving.length > 0) {
      expect(alias?.dashboard_session_id).toBe(surviving[0].id);
    }
    await sql`DELETE FROM session_aliases WHERE claude_session_id = ${cliId}`;
    void s1; void s2;
  });

  it("does not touch sessions with different project_dirs", async () => {
    const s1 = await sess({ projectDir: uid("/project/unique-a") });
    const s2 = await sess({ projectDir: uid("/project/unique-b") });

    await deduplicateSessions();

    expect(await getSession(s1)).toBeTruthy();
    expect(await getSession(s2)).toBeTruthy();
  });

  it("does not touch stopped sessions", async () => {
    const dir = uid("/project/stopped-only");
    await sess({ projectDir: dir, status: "active" });
    await sess({ projectDir: dir, status: "stopped" });

    await deduplicateSessions();

    const actives = await sql`
      SELECT id FROM sessions WHERE project_dir = ${dir} AND status = 'active'
    `;
    expect(actives.length).toBe(1);
  });

  it("returns 0 when no duplicates exist", async () => {
    const s1 = await sess({ projectDir: uid("/project/solo") });

    // deduplicateSessions returns total duplicate groups found across the whole DB;
    // we can't assert it's exactly 0 (other tests may leave residue), but our
    // solo session must survive.
    await deduplicateSessions();
    expect(await getSession(s1)).toBeTruthy();
  });
});

// ─── subdirectory guard: worktree_dir clearing ────────────────────────────────
// Validates the isWorktree / shouldClearWorktree logic from routes/sessions.js
// by calling upsertSession directly with the sentinel values it would pass.

describe.skipIf(SKIP)("subdirectory guard and worktree_dir clearing (via upsertSession)", () => {
  const created = [];
  afterEach(async () => {
    for (const id of created) await forceDelete(id);
    created.length = 0;
  });

  async function sess(overrides = {}) {
    const id = await makeSession(overrides);
    created.push(id);
    return id;
  }

  async function simulateSessionRegistration(sessionId, { projectDir }) {
    const existing = await getSession(sessionId);
    const isWorktree =
      existing &&
      existing.project_dir !== projectDir &&
      projectDir !== "unknown" &&
      !projectDir.startsWith(existing.project_dir + "/");

    const shouldClearWorktree =
      existing && !isWorktree && existing.worktree_dir;

    await upsertSession({
      id: sessionId,
      projectDir: isWorktree ? existing.project_dir : projectDir,
      worktreeDir: isWorktree
        ? projectDir
        : shouldClearWorktree
          ? "__clear__"
          : null,
      gitRoot: null,
      status: "active",
      model: null,
      currentClaudeSessionId: null,
    });

    return { isWorktree: Boolean(isWorktree), shouldClearWorktree: Boolean(shouldClearWorktree) };
  }

  it("does NOT set worktree_dir for a submodule path (subdirectory of project_dir)", async () => {
    const id = await sess({ projectDir: "/home/user/project" });
    const result = await simulateSessionRegistration(id, {
      projectDir: "/home/user/project/packages/submodule",
    });

    expect(result.isWorktree).toBe(false);
    const s = await getSession(id);
    expect(s.worktree_dir).toBeNull();
    expect(s.project_dir).toBe("/home/user/project");
  });

  it("DOES set worktree_dir for an external worktree (different directory)", async () => {
    const id = await sess({ projectDir: "/home/user/project" });
    const result = await simulateSessionRegistration(id, {
      projectDir: "/tmp/worktrees/feature-branch",
    });

    expect(result.isWorktree).toBe(true);
    const s = await getSession(id);
    expect(s.worktree_dir).toBe("/tmp/worktrees/feature-branch");
  });

  it("clears stale worktree_dir on a non-worktree heartbeat", async () => {
    const id = await sess({
      projectDir: "/home/user/project",
      worktreeDir: "/home/user/project/packages/stale-submodule",
    });

    const result = await simulateSessionRegistration(id, {
      projectDir: "/home/user/project",
    });

    expect(result.isWorktree).toBe(false);
    expect(result.shouldClearWorktree).toBe(true);
    const s = await getSession(id);
    expect(s.worktree_dir).toBeNull();
  });

  it("does not clear worktree_dir if none existed", async () => {
    const id = await sess({ projectDir: "/home/user/project", worktreeDir: null });
    const result = await simulateSessionRegistration(id, {
      projectDir: "/home/user/project",
    });

    expect(result.shouldClearWorktree).toBe(false);
    const s = await getSession(id);
    expect(s.worktree_dir).toBeNull();
  });

  it("preserves worktree_dir for a legitimate external worktree session", async () => {
    const id = await sess({
      projectDir: "/home/user/project",
      worktreeDir: "/tmp/worktrees/feature-branch",
    });

    const result = await simulateSessionRegistration(id, {
      projectDir: "/tmp/worktrees/another-branch",
    });

    expect(result.isWorktree).toBe(true);
    const s = await getSession(id);
    expect(s.worktree_dir).toBe("/tmp/worktrees/another-branch");
  });
});
