import { describe, expect, it, beforeEach, afterEach } from "bun:test";

/**
 * Tests for session alias resolution, lookup, and deletion logic.
 *
 * These tests call the async db-supabase.js functions directly and require
 * a real PostgreSQL connection. Set SUPABASE_DB_URL to run them.
 *
 * When SUPABASE_DB_URL is not set all suites are skipped so the CI test
 * run that exercises unit logic (stream-parser, broadcast, etc.) still
 * passes without a database.
 *
 * db-pg.js throws at module load time when SUPABASE_DB_URL is absent, so
 * we use a conditional dynamic import to avoid the error in skip-mode.
 */

const SKIP = !process.env.SUPABASE_DB_URL;

// Lazily-populated DB handles — only defined when SKIP is false.
let upsertSession, getSession, getAlias, insertAlias,
    insertEvent, insertAgent, insertWorktree,
    getSessionWorktrees, getSessionAgents, getSessionEvents,
    deleteSession, sql;

if (!SKIP) {
  ({
    upsertSession, getSession, getAlias, insertAlias,
    insertEvent, insertAgent, insertWorktree,
    getSessionWorktrees, getSessionAgents, getSessionEvents,
    deleteSession, sql,
  } = await import("./db-supabase.js"));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let idSeq = 0;
function uid(prefix = "s") {
  return `${prefix}-test-${Date.now()}-${++idSeq}`;
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

async function forceDelete(sessionId) {
  await sql`DELETE FROM worktrees       WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM agents          WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM events          WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM session_aliases WHERE dashboard_session_id = ${sessionId}`;
  await sql`DELETE FROM sessions        WHERE id = ${sessionId}`;
}

async function deleteAlias(claudeSessionId) {
  await sql`DELETE FROM session_aliases WHERE claude_session_id = ${claudeSessionId}`;
}

// ─── getAlias / insertAlias ───────────────────────────────────────────────────

describe.skipIf(SKIP)("getAlias / insertAlias (alias primitives)", () => {
  it("returns null for an unknown claude session id", async () => {
    const alias = await getAlias(uid("unknown"));
    expect(alias).toBeNull();
  });

  it("round-trips an alias", async () => {
    const cli = uid("cli");
    const dash = uid("dash");
    await insertAlias(cli, dash);
    const alias = await getAlias(cli);
    expect(alias?.dashboard_session_id).toBe(dash);
    await deleteAlias(cli);
  });

  it("upserts (idempotent) on re-insert with same claude id", async () => {
    const cli = uid("cli");
    const dash1 = uid("d1");
    const dash2 = uid("d2");
    await insertAlias(cli, dash1);
    await insertAlias(cli, dash2); // ON CONFLICT DO UPDATE
    const alias = await getAlias(cli);
    expect(alias?.dashboard_session_id).toBe(dash2);
    await deleteAlias(cli);
  });
});

// ─── upsertSession edge cases ────────────────────────────────────────────────

describe.skipIf(SKIP)("upsertSession", () => {
  const ids = [];
  beforeEach(() => { ids.length = 0; });
  afterEach(async () => {
    for (const id of ids) await forceDelete(id);
  });

  async function sess(overrides = {}) {
    const id = await makeSession(overrides);
    ids.push(id);
    return id;
  }

  it("preserves model on null update", async () => {
    const id = await sess({ model: "opus-4" });
    await upsertSession({
      id, projectDir: "/p", worktreeDir: null, gitRoot: null,
      status: "active", model: null, currentClaudeSessionId: null,
    });
    const s = await getSession(id);
    expect(s.model).toBe("opus-4");
  });

  it("updates model when new value is provided", async () => {
    const id = await sess({ model: "opus-4" });
    await upsertSession({
      id, projectDir: "/p", worktreeDir: null, gitRoot: null,
      status: "active", model: "sonnet-4", currentClaudeSessionId: null,
    });
    const s = await getSession(id);
    expect(s.model).toBe("sonnet-4");
  });

  it("does not overwrite project_dir with 'unknown'", async () => {
    const id = await sess({ projectDir: "/real/path" });
    await upsertSession({
      id, projectDir: "unknown", worktreeDir: null, gitRoot: null,
      status: "active", model: null, currentClaudeSessionId: null,
    });
    const s = await getSession(id);
    expect(s.project_dir).toBe("/real/path");
  });

  it("upgrades project_dir from 'unknown' to real path", async () => {
    const id = await sess({ projectDir: "unknown" });
    await upsertSession({
      id, projectDir: "/real/path", worktreeDir: null, gitRoot: null,
      status: "active", model: null, currentClaudeSessionId: null,
    });
    const s = await getSession(id);
    expect(s.project_dir).toBe("/real/path");
  });

  it("preserves worktree_dir on null update", async () => {
    const id = await sess({ worktreeDir: "/wt" });
    await upsertSession({
      id, projectDir: "/p", worktreeDir: null, gitRoot: null,
      status: "active", model: null, currentClaudeSessionId: null,
    });
    const s = await getSession(id);
    expect(s.worktree_dir).toBe("/wt");
  });

  it("preserves current_claude_session_id on null update", async () => {
    const id = await sess({ currentClaudeSessionId: "real-cli-id" });
    await upsertSession({
      id, projectDir: "/p", worktreeDir: null, gitRoot: null,
      status: "active", model: null, currentClaudeSessionId: null,
    });
    const s = await getSession(id);
    expect(s.current_claude_session_id).toBe("real-cli-id");
  });
});

// ─── upsertSession worktree_dir __clear__ sentinel ───────────────────────────

describe.skipIf(SKIP)("upsertSession worktree_dir clearing", () => {
  const ids = [];
  beforeEach(() => { ids.length = 0; });
  afterEach(async () => {
    for (const id of ids) await forceDelete(id);
  });

  async function sess(overrides = {}) {
    const id = await makeSession(overrides);
    ids.push(id);
    return id;
  }

  it("clears worktree_dir when __clear__ sentinel is passed", async () => {
    const id = await sess({ projectDir: "/project/root", worktreeDir: "/stale/worktree" });
    expect((await getSession(id)).worktree_dir).toBe("/stale/worktree");

    await upsertSession({
      id, projectDir: "/project/root", worktreeDir: "__clear__", gitRoot: null,
      status: "active", model: null, currentClaudeSessionId: null,
    });
    expect((await getSession(id)).worktree_dir).toBeNull();
  });

  it("preserves worktree_dir when null is passed (COALESCE behavior)", async () => {
    const id = await sess({ worktreeDir: "/existing/wt" });
    await upsertSession({
      id, projectDir: "/p", worktreeDir: null, gitRoot: null,
      status: "active", model: null, currentClaudeSessionId: null,
    });
    expect((await getSession(id)).worktree_dir).toBe("/existing/wt");
  });

  it("sets worktree_dir when a real path is passed", async () => {
    const id = await sess({ worktreeDir: null });
    await upsertSession({
      id, projectDir: "/p", worktreeDir: "/new/worktree", gitRoot: null,
      status: "active", model: null, currentClaudeSessionId: null,
    });
    expect((await getSession(id)).worktree_dir).toBe("/new/worktree");
  });

  it("can re-set worktree_dir after clearing", async () => {
    const id = await sess({ worktreeDir: "/old" });
    await upsertSession({
      id, projectDir: "/p", worktreeDir: "__clear__", gitRoot: null,
      status: "active", model: null, currentClaudeSessionId: null,
    });
    expect((await getSession(id)).worktree_dir).toBeNull();

    await upsertSession({
      id, projectDir: "/p", worktreeDir: "/new", gitRoot: null,
      status: "active", model: null, currentClaudeSessionId: null,
    });
    expect((await getSession(id)).worktree_dir).toBe("/new");
  });
});

// ─── deleteSession ───────────────────────────────────────────────────────────

describe.skipIf(SKIP)("deleteSession", () => {
  it("returns false for non-existent session", async () => {
    expect(await deleteSession(uid("nonexistent"))).toBe(false);
  });

  it("returns false for active session", async () => {
    const id = await makeSession({ status: "active" });
    expect(await deleteSession(id)).toBe(false);
    expect(await getSession(id)).toBeTruthy();
    await forceDelete(id);
  });

  it("deletes a stopped session", async () => {
    const id = await makeSession({ status: "stopped" });
    expect(await deleteSession(id)).toBe(true);
    expect(await getSession(id)).toBeNull();
  });

  it("deletes error-status session", async () => {
    const id = await makeSession({ status: "error" });
    expect(await deleteSession(id)).toBe(true);
    expect(await getSession(id)).toBeNull();
  });

  it("cascade-deletes events", async () => {
    const id = await makeSession({ status: "stopped" });
    await insertEvent({ sessionId: id, type: "tool_use", toolName: "Read" });

    const eventsBefore = await getSessionEvents(id);
    expect(eventsBefore.length).toBeGreaterThan(0);

    await deleteSession(id);
    const eventsAfter = await getSessionEvents(id);
    expect(eventsAfter).toHaveLength(0);
  });

  it("cascade-deletes agents", async () => {
    const id = await makeSession({ status: "stopped" });
    const { id: eventId } = await insertEvent({ sessionId: id, type: "tool_use", toolName: "Agent" });
    await insertAgent({
      sessionId: id, eventId, description: "test",
      agentType: "general-purpose", prompt: "do stuff", status: "completed",
    });

    const agentsBefore = await getSessionAgents(id);
    expect(agentsBefore.length).toBeGreaterThan(0);

    await deleteSession(id);
    const agentsAfter = await getSessionAgents(id);
    expect(agentsAfter).toHaveLength(0);
  });

  it("cascade-deletes worktrees", async () => {
    const id = await makeSession({ status: "stopped" });
    await insertWorktree({
      sessionId: id, branchName: uid("agent/test"), baseBranch: "main",
      description: "test", agentId: null, status: "ready",
    });

    const wtBefore = await getSessionWorktrees(id);
    expect(wtBefore.length).toBeGreaterThan(0);

    await deleteSession(id);
    const wtAfter = await getSessionWorktrees(id);
    expect(wtAfter).toHaveLength(0);
  });

  it("cascade-deletes aliases", async () => {
    const id = await makeSession({ status: "stopped" });
    const cli1 = uid("cli");
    const cli2 = uid("cli");
    await insertAlias(cli1, id);
    await insertAlias(cli2, id);

    await deleteSession(id);
    expect(await getAlias(cli1)).toBeNull();
    expect(await getAlias(cli2)).toBeNull();
  });
});

// ─── Worktree unique constraint ──────────────────────────────────────────────

describe.skipIf(SKIP)("worktree constraints", () => {
  it("upserts on duplicate (session_id, branch_name)", async () => {
    const id = await makeSession();
    const branch = uid("agent/test");

    await insertWorktree({
      sessionId: id, branchName: branch, baseBranch: "main",
      description: "first", agentId: null, status: "pending",
    });
    await insertWorktree({
      sessionId: id, branchName: branch, baseBranch: "main",
      description: "updated", agentId: null, status: "ready",
    });

    const wts = await getSessionWorktrees(id);
    const matching = wts.filter((w) => w.branch_name === branch);
    expect(matching).toHaveLength(1);
    expect(matching[0].description).toBe("updated");
    expect(matching[0].status).toBe("ready");

    await forceDelete(id);
  });

  it("allows same branch name for different sessions", async () => {
    const id1 = await makeSession({ projectDir: "/p1" });
    const id2 = await makeSession({ projectDir: "/p2" });
    const branch = uid("agent/test");

    await insertWorktree({
      sessionId: id1, branchName: branch, baseBranch: "main",
      description: "s1", agentId: null, status: "pending",
    });
    await insertWorktree({
      sessionId: id2, branchName: branch, baseBranch: "main",
      description: "s2", agentId: null, status: "pending",
    });

    const wts1 = (await getSessionWorktrees(id1)).filter((w) => w.branch_name === branch);
    const wts2 = (await getSessionWorktrees(id2)).filter((w) => w.branch_name === branch);
    expect(wts1).toHaveLength(1);
    expect(wts2).toHaveLength(1);

    await forceDelete(id1);
    await forceDelete(id2);
  });
});
