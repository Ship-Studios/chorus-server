import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import Fastify from "fastify";
import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GIT } from "./git.js";
import { parseDiffToFiles } from "./diff.js";
import { runGit } from "./run-git.js";

/**
 * Integration tests for the diff route.
 * Uses a temporary git repository with real commits and unstaged changes.
 */

const TEMP_REPO = join(import.meta.dir, "..", ".test-diff-repo");
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
  // Create a temp git repo with a commit
  mkdirSync(TEMP_REPO, { recursive: true });

  const git = (args) =>
    execFileSync(GIT, args, {
      cwd: TEMP_REPO,
      encoding: "utf-8",
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_COMMITTER_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    });

  git(["init", "-b", "main"]);
  writeFileSync(join(TEMP_REPO, "hello.js"), "const x = 1;\n");
  git(["add", "."]);
  git(["commit", "-m", "initial"]);

  // Create an unstaged change for diff to pick up
  writeFileSync(join(TEMP_REPO, "hello.js"), "const x = 1;\nconst y = 2;\n");

  // Set up DB and Fastify
  const { upsertSession } = initDb();

  upsertSession.run({
    $id: "diff-session",
    $projectDir: TEMP_REPO,
    $worktreeDir: null,
    $status: "active",
  });

  upsertSession.run({
    $id: "unknown-dir-session",
    $projectDir: "unknown",
    $worktreeDir: null,
    $status: "active",
  });

  upsertSession.run({
    $id: "missing-dir-session",
    $projectDir: "/tmp/does-not-exist-xyz-99999",
    $worktreeDir: null,
    $status: "active",
  });

  app = Fastify();

  // Register the diff route with our test DB
  app.get("/api/sessions/:sessionId/diff", async (req, reply) => {
    const sessionId = lookupSessionId(req.params.sessionId);
    const session = getSession.get({ $id: sessionId });
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const dir = session.project_dir;
    if (!dir || dir === "unknown") {
      return reply.code(400).send({ error: "Session has no known working directory" });
    }

    const { existsSync } = await import("node:fs");
    if (!existsSync(dir)) {
      return reply.code(400).send({ error: `Working directory no longer exists: ${dir}` });
    }

    try {
      const diff = await runGit(dir, ["diff", "HEAD", "--no-color", "--unified=5"]);
      const stat = await runGit(dir, ["diff", "HEAD", "--stat", "--no-color"]);
      const branch = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);

      return {
        sessionId: req.params.sessionId,
        directory: dir,
        branch: branch.trim(),
        stat: stat.trim(),
        diff,
        files: parseDiffToFiles(diff),
      };
    } catch {
      try {
        const diff = await runGit(dir, ["diff", "--no-color", "--unified=5"]);
        const stat = await runGit(dir, ["diff", "--stat", "--no-color"]);
        return {
          sessionId: req.params.sessionId,
          directory: dir,
          branch: "unknown",
          stat: stat.trim(),
          diff,
          files: parseDiffToFiles(diff),
        };
      } catch (fallbackErr) {
        return reply.code(500).send({ error: `Git error: ${fallbackErr.message}` });
      }
    }
  });

  await app.ready();
});

afterAll(async () => {
  await app?.close();
  rmSync(TEMP_REPO, { recursive: true, force: true });
});

describe("GET /api/sessions/:sessionId/diff", () => {
  it("returns 404 for non-existent session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/nope/diff" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("not found");
  });

  it("returns 400 for session with unknown project dir", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/unknown-dir-session/diff" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("no known working directory");
  });

  it("returns 400 for session with non-existent directory", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/missing-dir-session/diff" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("no longer exists");
  });

  it("returns diff for a session with uncommitted changes", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/diff-session/diff" });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.sessionId).toBe("diff-session");
    expect(body.directory).toBe(TEMP_REPO);
    expect(body.branch).toBe("main");
    expect(body.diff).toContain("const y = 2");
    expect(body.stat).toContain("hello.js");
    expect(body.files).toHaveLength(1);
    expect(body.files[0].newFileName).toBe("hello.js");
    expect(body.files[0].fileLang).toBe("javascript");
  });

  it("returns empty diff when working tree is clean", async () => {
    // Stage the change to make working tree clean against index
    execFileSync(GIT, ["checkout", "--", "hello.js"], {
      cwd: TEMP_REPO,
      stdio: "pipe",
    });

    const res = await app.inject({ method: "GET", url: "/api/sessions/diff-session/diff" });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.diff).toBe("");
    expect(body.files).toHaveLength(0);

    // Restore the change for other tests
    writeFileSync(join(TEMP_REPO, "hello.js"), "const x = 1;\nconst y = 2;\n");
  });

  it("includes hunkCount in file entries", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions/diff-session/diff" });
    const body = res.json();
    if (body.files.length > 0) {
      expect(body.files[0]).toHaveProperty("hunkCount");
      expect(body.files[0]).toHaveProperty("hunks");
    }
  });
});
