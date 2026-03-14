import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GIT } from "./git.js";
import { parseDiffToFiles } from "./diff.js";
import { runGit } from "./run-git.js";

/**
 * Integration tests for worktree route handlers.
 * Uses a temporary git repository with branches to test:
 * - worktree listing with auto-discovery
 * - diff between branches
 * - file listing
 * - conflict detection
 */

const TEMP_REPO = join(import.meta.dir, "..", ".test-worktree-repo");
let app;
let db;
let stmts;
let tempLinkedWorktree;

function uniqueTempPath(prefix) {
  return join(import.meta.dir, "..", `.${prefix}-${randomUUID().slice(0, 8)}`);
}

function git(args, opts = {}) {
  return execFileSync(GIT, args, {
    cwd: opts.cwd || TEMP_REPO,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: 10000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_COMMITTER_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_EMAIL: "test@test.com",
    },
  });
}

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
    CREATE UNIQUE INDEX idx_worktrees_branch ON worktrees(session_id, branch_name);
  `);

  return {
    upsertSession: db.prepare(`
      INSERT INTO sessions (id, project_dir, worktree_dir, status) VALUES ($id, $projectDir, $worktreeDir, $status)
    `),
    getSession: db.prepare(`SELECT * FROM sessions WHERE id = $id`),
    getWorktree: db.prepare(`SELECT * FROM worktrees WHERE id = $id`),
    getWorktreeByBranch: db.prepare(`SELECT * FROM worktrees WHERE session_id = $sessionId AND branch_name = $branchName`),
    insertWorktree: db.prepare(`
      INSERT INTO worktrees (session_id, branch_name, base_branch, description, agent_id, status)
      VALUES ($sessionId, $branchName, $baseBranch, $description, $agentId, $status)
      ON CONFLICT (session_id, branch_name) DO UPDATE SET
        description = excluded.description, status = excluded.status, updated_at = datetime('now')
      RETURNING id
    `),
    updateWorktreeStatus: db.prepare(`UPDATE worktrees SET status = $status, updated_at = datetime('now') WHERE id = $id`),
    updateWorktreeConflicts: db.prepare(`UPDATE worktrees SET conflict_info = $conflictInfo, updated_at = datetime('now') WHERE id = $id`),
    deleteWorktreeRow: db.prepare(`DELETE FROM worktrees WHERE id = $id`),
    getSessionWorktrees: db.prepare(`SELECT * FROM worktrees WHERE session_id = $sessionId ORDER BY created_at DESC`),
    lookupSessionId: (id) => {
      const alias = db.prepare(`SELECT dashboard_session_id FROM session_aliases WHERE claude_session_id = $claudeSessionId`).get({ $claudeSessionId: id });
      return alias ? alias.dashboard_session_id : id;
    },
  };
}

function registerRoutes(fastify, s) {
  // GET /api/sessions/:sessionId/worktrees — list with auto-discovery
  fastify.get("/api/sessions/:sessionId/worktrees", async (req) => {
    const sessionId = s.lookupSessionId(req.params.sessionId);
    return s.getSessionWorktrees.all({ $sessionId: sessionId });
  });

  // GET /api/worktrees/:worktreeId/diff
  fastify.get("/api/worktrees/:worktreeId/diff", async (req, reply) => {
    const wt = s.getWorktree.get({ $id: Number(req.params.worktreeId) });
    if (!wt) return reply.code(404).send({ error: "Worktree not found" });

    const session = s.getSession.get({ $id: wt.session_id });
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const dir = session.project_dir;
    const { existsSync } = await import("node:fs");
    if (!dir || !existsSync(dir)) {
      return reply.code(400).send({ error: "Project directory not available" });
    }

    try {
      const range = `${wt.base_branch}...${wt.branch_name}`;
      const diff = await runGit(dir, ["diff", "--no-color", "--unified=5", range]);
      const stat = await runGit(dir, ["diff", "--stat", "--no-color", range]);
      return { worktreeId: wt.id, branchName: wt.branch_name, baseBranch: wt.base_branch, stat: stat.trim(), diff, files: parseDiffToFiles(diff) };
    } catch (err) {
      return reply.code(500).send({ error: `Git error: ${err.message}` });
    }
  });

  // GET /api/worktrees/:worktreeId/files
  fastify.get("/api/worktrees/:worktreeId/files", async (req, reply) => {
    const wt = s.getWorktree.get({ $id: Number(req.params.worktreeId) });
    if (!wt) return reply.code(404).send({ error: "Worktree not found" });

    const session = s.getSession.get({ $id: wt.session_id });
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const dir = session.project_dir;
    const { existsSync } = await import("node:fs");
    if (!dir || !existsSync(dir)) {
      return reply.code(400).send({ error: "Project directory not available" });
    }

    try {
      const namestat = await runGit(dir, ["diff", "--name-status", `${wt.base_branch}...${wt.branch_name}`]);
      const files = namestat.trim().split("\n").filter(Boolean).map((line) => {
        const [status, ...rest] = line.split("\t");
        return { status, file: rest.join("\t") };
      });
      return { worktreeId: wt.id, files };
    } catch (err) {
      return reply.code(500).send({ error: `Git error: ${err.message}` });
    }
  });

  // POST /api/worktrees/:worktreeId/check-conflicts
  fastify.post("/api/worktrees/:worktreeId/check-conflicts", async (req, reply) => {
    const wt = s.getWorktree.get({ $id: Number(req.params.worktreeId) });
    if (!wt) return reply.code(404).send({ error: "Worktree not found" });

    const session = s.getSession.get({ $id: wt.session_id });
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const dir = session.project_dir;
    const { existsSync } = await import("node:fs");
    if (!dir || !existsSync(dir)) {
      return reply.code(400).send({ error: "Project directory not available" });
    }

    // Inline conflict detection to avoid importing prompt.js (which has side effects)
    let conflictInfo = null;
    try {
      execFileSync(GIT, ["merge-tree", "--write-tree", wt.base_branch, wt.branch_name], {
        cwd: dir, encoding: "utf-8", timeout: 15000, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const output = err.stdout?.toString?.() || err.message;
      const conflicts = [];
      for (const line of output.split("\n")) {
        if (line.startsWith("CONFLICT")) conflicts.push(line);
      }
      conflictInfo = conflicts.length > 0 ? conflicts.join("\n") : "Merge conflicts detected";
    }

    s.updateWorktreeConflicts.run({ $id: wt.id, $conflictInfo: conflictInfo });
    const updated = s.getWorktree.get({ $id: wt.id });
    return { ok: true, conflicts: !!conflictInfo, conflictInfo };
  });

  fastify.delete("/api/worktrees/:worktreeId", async (req, reply) => {
    const wt = s.getWorktree.get({ $id: Number(req.params.worktreeId) });
    if (!wt) return reply.code(404).send({ error: "Worktree not found" });

    const session = s.getSession.get({ $id: wt.session_id });
    if (session) {
      const dir = session.project_dir;
      const { existsSync } = await import("node:fs");
      if (dir && existsSync(dir)) {
        try {
          const out = await runGit(dir, ["worktree", "list", "--porcelain"]);
          let currentPath = null;
          let currentBranch = null;
          for (const line of out.split("\n")) {
            if (line.startsWith("worktree ")) {
              currentPath = line.slice(9).trim();
              currentBranch = null;
            } else if (line.startsWith("branch refs/heads/")) {
              currentBranch = line.slice("branch refs/heads/".length).trim();
            } else if (line === "") {
              if (currentBranch === wt.branch_name && currentPath && existsSync(currentPath)) {
                execFileSync(GIT, ["worktree", "remove", "--force", currentPath], {
                  cwd: dir,
                  stdio: "pipe",
                  timeout: 15000,
                });
              }
              currentPath = null;
              currentBranch = null;
            }
          }
        } catch {}

        if (wt.status !== "merged") {
          execFileSync(GIT, ["branch", "-D", wt.branch_name], {
            cwd: dir,
            stdio: "pipe",
            timeout: 5000,
          });
        }
      }
    }

    s.deleteWorktreeRow.run({ $id: wt.id });
    return { ok: true };
  });
}

beforeAll(async () => {
  // Create a temp git repo
  tempLinkedWorktree = uniqueTempPath("test-linked-worktree");
  rmSync(TEMP_REPO, { recursive: true, force: true });
  rmSync(tempLinkedWorktree, { recursive: true, force: true });
  mkdirSync(TEMP_REPO, { recursive: true });
  git(["init", "-b", "main"]);
  writeFileSync(join(TEMP_REPO, "app.js"), "const app = 1;\n");
  git(["add", "."]);
  git(["commit", "-m", "initial commit"]);

  // Create a feature branch with a change
  git(["checkout", "-b", "agent/feature-abc123"]);
  writeFileSync(join(TEMP_REPO, "feature.js"), "export const feature = true;\n");
  writeFileSync(join(TEMP_REPO, "app.js"), "const app = 1;\nconst updated = true;\n");
  git(["add", "."]);
  git(["commit", "-m", "add feature"]);
  git(["checkout", "main"]);
  git(["worktree", "add", tempLinkedWorktree, "agent/feature-abc123"]);

  // Set up DB and routes
  stmts = initDb();

  stmts.upsertSession.run({
    $id: "wt-session",
    $projectDir: TEMP_REPO,
    $worktreeDir: null,
    $status: "active",
  });

  // Pre-register a worktree record for the feature branch
  stmts.insertWorktree.get({
    $sessionId: "wt-session",
    $branchName: "agent/feature-abc123",
    $baseBranch: "main",
    $description: "feature work",
    $agentId: null,
    $status: "ready",
  });

  app = Fastify();
  registerRoutes(app, stmts);
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  try {
    git(["worktree", "remove", "--force", tempLinkedWorktree]);
  } catch {}
  rmSync(TEMP_REPO, { recursive: true, force: true });
  rmSync(tempLinkedWorktree, { recursive: true, force: true });
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /api/sessions/:sessionId/worktrees", () => {
  it("lists worktrees for a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/wt-session/worktrees" });
    expect(res.statusCode).toBe(200);
    const wts = res.json();
    expect(wts).toHaveLength(1);
    expect(wts[0].branch_name).toBe("agent/feature-abc123");
    expect(wts[0].base_branch).toBe("main");
    expect(wts[0].description).toBe("feature work");
  });

  it("returns empty array for session with no worktrees", async () => {
    stmts.upsertSession.run({
      $id: "empty-session",
      $projectDir: "/tmp",
      $worktreeDir: null,
      $status: "active",
    });
    const res = await app.inject({ method: "GET", url: "/api/sessions/empty-session/worktrees" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe("GET /api/worktrees/:worktreeId/diff", () => {
  it("returns 404 for non-existent worktree", async () => {
    const res = await app.inject({ method: "GET", url: "/api/worktrees/9999/diff" });
    expect(res.statusCode).toBe(404);
  });

  it("returns diff between base and feature branch", async () => {
    const wt = stmts.getWorktreeByBranch.get({
      $sessionId: "wt-session",
      $branchName: "agent/feature-abc123",
    });
    const res = await app.inject({ method: "GET", url: `/api/worktrees/${wt.id}/diff` });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.branchName).toBe("agent/feature-abc123");
    expect(body.baseBranch).toBe("main");
    expect(body.diff).toContain("feature.js");
    expect(body.files.length).toBeGreaterThanOrEqual(1);
    // Should include the new file
    const featureFile = body.files.find((f) => f.newFileName === "feature.js");
    expect(featureFile).toBeTruthy();
  });
});

describe("GET /api/worktrees/:worktreeId/files", () => {
  it("returns 404 for non-existent worktree", async () => {
    const res = await app.inject({ method: "GET", url: "/api/worktrees/9999/files" });
    expect(res.statusCode).toBe(404);
  });

  it("lists changed files between branches", async () => {
    const wt = stmts.getWorktreeByBranch.get({
      $sessionId: "wt-session",
      $branchName: "agent/feature-abc123",
    });
    const res = await app.inject({ method: "GET", url: `/api/worktrees/${wt.id}/files` });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.files.length).toBeGreaterThanOrEqual(1);
    // feature.js was added
    const added = body.files.find((f) => f.file === "feature.js");
    expect(added).toBeTruthy();
    expect(added.status).toBe("A");
    // app.js was modified
    const modified = body.files.find((f) => f.file === "app.js");
    expect(modified).toBeTruthy();
    expect(modified.status).toBe("M");
  });
});

describe("POST /api/worktrees/:worktreeId/check-conflicts", () => {
  it("returns 404 for non-existent worktree", async () => {
    const res = await app.inject({ method: "POST", url: "/api/worktrees/9999/check-conflicts" });
    expect(res.statusCode).toBe(404);
  });

  it("reports no conflicts for a clean merge", async () => {
    const wt = stmts.getWorktreeByBranch.get({
      $sessionId: "wt-session",
      $branchName: "agent/feature-abc123",
    });
    const res = await app.inject({ method: "POST", url: `/api/worktrees/${wt.id}/check-conflicts` });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.conflicts).toBe(false);
    expect(body.conflictInfo).toBeNull();
  });

  it("stores conflict info in the DB", async () => {
    // Create a conflicting branch
    git(["checkout", "main"]);
    writeFileSync(join(TEMP_REPO, "app.js"), "const app = 'conflicting change';\n");
    git(["add", "."]);
    git(["commit", "-m", "conflicting change on main"]);

    // Now agent/feature-abc123 modifies the same file differently
    const { id: conflictWtId } = stmts.insertWorktree.get({
      $sessionId: "wt-session",
      $branchName: "agent/feature-abc123",
      $baseBranch: "main",
      $description: "feature work",
      $agentId: null,
      $status: "ready",
    });

    const res = await app.inject({ method: "POST", url: `/api/worktrees/${conflictWtId}/check-conflicts` });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.ok).toBe(true);
    // Now there should be conflicts since both branches modify app.js
    expect(body.conflicts).toBe(true);
    expect(typeof body.conflictInfo).toBe("string");

    // Verify stored in DB
    const stored = stmts.getWorktree.get({ $id: conflictWtId });
    expect(stored.conflict_info).toBeTruthy();
  });
});

describe("DELETE /api/worktrees/:worktreeId", () => {
  it("removes the linked worktree before deleting the branch", async () => {
    const { id } = stmts.insertWorktree.get({
      $sessionId: "wt-session",
      $branchName: "agent/delete-me",
      $baseBranch: "main",
      $description: "delete me",
      $agentId: null,
      $status: "ready",
    });

    git(["branch", "agent/delete-me", "main"]);
    const linkedPath = uniqueTempPath("test-delete-worktree");
    rmSync(linkedPath, { recursive: true, force: true });
    git(["worktree", "add", linkedPath, "agent/delete-me"]);

    try {
      const res = await app.inject({ method: "DELETE", url: `/api/worktrees/${id}` });
      expect(res.statusCode).toBe(200);
      expect(stmts.getWorktree.get({ $id: id })).toBeNull();

      const worktreeList = git(["worktree", "list", "--porcelain"]);
      expect(worktreeList).not.toContain(linkedPath);
      expect(() => git(["rev-parse", "--verify", "agent/delete-me"])).toThrow();
    } finally {
      rmSync(linkedPath, { recursive: true, force: true });
    }
  });
});
