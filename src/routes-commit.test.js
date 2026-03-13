import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import Fastify from "fastify";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT } from "./git.js";
import { runGit as actualRunGit } from "./run-git.js";

const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
const originalModel = process.env.DIFF_SUMMARY_MODEL;

const sessions = new Map();
const sessionAliases = new Map();
const broadcastCalls = [];
const anthropicConstructCalls = [];
const anthropicCreateCalls = [];
const anthropicResponses = [];

let anthropicError = null;
let apps = [];
let tempRoots = [];

mock.module("./db.js", () => ({
  getSession: {
    get({ $id }) {
      return sessions.get($id) ?? null;
    },
  },
  lookupSessionId(id) {
    return sessionAliases.get(id) ?? id;
  },
}));

mock.module("./broadcast.js", () => ({
  broadcast(message) {
    broadcastCalls.push(message);
  },
}));

mock.module("./vpn.js", () => ({
  getAnthropicFetchOptions() {
    return { baseURL: "https://example.invalid" };
  },
}));

mock.module("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    constructor(options = {}) {
      anthropicConstructCalls.push(options);
      this.messages = {
        create: async (payload) => {
          anthropicCreateCalls.push(payload);
          if (anthropicError) throw anthropicError;
          const text = anthropicResponses.length > 0
            ? anthropicResponses.shift()
            : "fix(commit): generated commit message";
          return { content: [{ text }] };
        },
      };
    }
  },
}));

const {
  default: commitRoutes,
  createBuildPreviewDiff,
  createCommitRoutes,
  resetClient,
} = await import("./routes/commit.js");

function git(cwd, args) {
  return execFileSync(GIT, args, {
    cwd,
    encoding: "utf-8",
    stdio: "pipe",
    timeout: 15_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_COMMITTER_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

function createCommittedRepo() {
  const root = mkdtempSync(join(tmpdir(), "routes-commit-"));
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  git(repoDir, ["init", "-b", "main"]);
  writeFileSync(join(repoDir, "app.js"), "export const base = 1;\n");
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "chore: initial"]);
  tempRoots.push(root);
  return { root, repoDir };
}

function createRepoWithoutHead() {
  const root = mkdtempSync(join(tmpdir(), "routes-commit-no-head-"));
  const repoDir = join(root, "repo");
  mkdirSync(repoDir);
  git(repoDir, ["init", "-b", "main"]);
  writeFileSync(join(repoDir, "first.js"), "export const first = true;\n");
  tempRoots.push(root);
  return { root, repoDir };
}

function createExistingDirectory() {
  const dir = mkdtempSync(join(tmpdir(), "routes-commit-existing-dir-"));
  tempRoots.push(dir);
  return dir;
}

function registerSession(id, session) {
  sessions.set(id, {
    id,
    worktree_dir: null,
    ...session,
  });
}

async function createApp() {
  const app = Fastify();
  await app.register(commitRoutes);
  await app.ready();
  apps.push(app);
  return app;
}

async function createInjectedApp(deps = {}) {
  const app = Fastify();
  await app.register(createCommitRoutes(deps));
  await app.ready();
  apps.push(app);
  return app;
}

beforeEach(() => {
  sessions.clear();
  sessionAliases.clear();
  broadcastCalls.length = 0;
  anthropicConstructCalls.length = 0;
  anthropicCreateCalls.length = 0;
  anthropicResponses.length = 0;
  anthropicError = null;
  apps = [];
  tempRoots = [];
  resetClient();
  process.env.ANTHROPIC_API_KEY = "test-api-key";
  delete process.env.DIFF_SUMMARY_MODEL;
});

afterEach(async () => {
  resetClient();
  for (const app of apps) {
    await app.close();
  }
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }

  if (originalAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;

  if (originalModel === undefined) delete process.env.DIFF_SUMMARY_MODEL;
  else process.env.DIFF_SUMMARY_MODEL = originalModel;
});

describe("createBuildPreviewDiff", () => {
  it("includes untracked files without mutating the real index", async () => {
    const { repoDir } = createCommittedRepo();
    writeFileSync(join(repoDir, "new-file.js"), "export const added = true;\n");

    const previewDiff = await createBuildPreviewDiff()(repoDir);

    expect(previewDiff).toContain("new-file.js");
    expect(previewDiff).toContain("new file mode");
    const status = git(repoDir, ["status", "--short"]);
    expect(status).toContain("?? new-file.js");
    expect(status).not.toContain("A  new-file.js");
  });

  it("falls back to diff --cached without HEAD for repos with no commits", async () => {
    const { repoDir } = createRepoWithoutHead();
    const runGitCalls = [];
    const buildPreviewDiff = createBuildPreviewDiff({
      runGit: async (dir, args, options) => {
        runGitCalls.push(args);
        return actualRunGit(dir, args, options);
      },
    });

    const previewDiff = await buildPreviewDiff(repoDir);

    expect(previewDiff).toContain("first.js");
    expect(previewDiff).toContain("new file mode");
    expect(runGitCalls).toEqual(expect.arrayContaining([
      ["rev-parse", "--git-path", "index"],
      ["add", "-A"],
      ["diff", "--cached", "HEAD", "--no-color", "--unified=3", "--submodule=diff"],
      ["diff", "--cached", "--no-color", "--unified=3", "--submodule=diff"],
    ]));
  });
});

describe("POST /api/sessions/:sessionId/commit", () => {
  it("returns 503 when ANTHROPIC_API_KEY is not set", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const app = await createApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/missing/commit",
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain("ANTHROPIC_API_KEY not set");
  });

  it("returns 404 for an unknown session", async () => {
    const app = await createApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/nope/commit",
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain("Session not found");
  });

  it("returns 400 when the session has no known working directory", async () => {
    registerSession("unknown-dir", {
      project_dir: "unknown",
    });
    const app = await createApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/unknown-dir/commit",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("no known working directory");
  });

  it("returns 400 when the working directory is missing", async () => {
    registerSession("missing-dir", {
      project_dir: "/tmp/does-not-exist-routes-commit",
    });
    const app = await createApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/missing-dir/commit",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("no longer exists");
  });

  it("returns 400 when there is nothing to commit", async () => {
    const { repoDir } = createCommittedRepo();
    registerSession("clean-session", {
      project_dir: repoDir,
    });
    const app = await createApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/clean-session/commit",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("No changes to commit");
    expect(anthropicCreateCalls).toHaveLength(0);
  });

  it("commits staged and unstaged changes, resolves aliases, and broadcasts invalidation", async () => {
    const { repoDir } = createCommittedRepo();
    writeFileSync(join(repoDir, "app.js"), "export const base = 1;\nexport const staged = true;\n");
    git(repoDir, ["add", "app.js"]);
    writeFileSync(join(repoDir, "notes.md"), "# Notes\n\nUpdated in working tree.\n");

    registerSession("real-session", {
      project_dir: repoDir,
    });
    sessionAliases.set("alias-session", "real-session");
    anthropicResponses.push("feat(server): commit pending changes");
    const app = await createApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/alias-session/commit",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      message: "feat(server): commit pending changes",
      stat: expect.stringContaining("2 files changed"),
      filesChanged: 2,
    });

    expect(git(repoDir, ["status", "--short"]).trim()).toBe("");
    expect(git(repoDir, ["log", "-1", "--pretty=%B"]).trim()).toBe("feat(server): commit pending changes");
    expect(broadcastCalls).toEqual([{ type: "diff:invalidated", sessionId: "real-session" }]);
    expect(anthropicConstructCalls).toHaveLength(1);
    expect(anthropicCreateCalls).toHaveLength(1);
    expect(anthropicCreateCalls[0].model).toBe("claude-haiku-4-5-20251001");
    expect(anthropicCreateCalls[0].messages[0].content).toContain("<stat>");
    expect(anthropicCreateCalls[0].messages[0].content).toContain("app.js");
    expect(anthropicCreateCalls[0].messages[0].content).toContain("notes.md");
    expect(anthropicCreateCalls[0].messages[0].content).toContain("<diff>");
  });

  it("includes untracked files in the generated commit prompt", async () => {
    const { repoDir } = createCommittedRepo();
    writeFileSync(join(repoDir, "new-file.js"), "export const added = true;\n");

    registerSession("untracked-session", {
      project_dir: repoDir,
    });
    anthropicResponses.push("feat(server): add untracked file");
    const app = await createApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/untracked-session/commit",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().filesChanged).toBe(1);
    expect(anthropicCreateCalls[0].messages[0].content).toContain("new-file.js");
    expect(git(repoDir, ["log", "-1", "--pretty=%B"]).trim()).toBe("feat(server): add untracked file");
    expect(git(repoDir, ["status", "--short"]).trim()).toBe("");
  });

  it("creates an initial commit when the repository has no HEAD yet", async () => {
    const { repoDir } = createRepoWithoutHead();

    registerSession("no-head-session", {
      project_dir: repoDir,
    });
    anthropicResponses.push("feat(init): create the first commit");
    const app = await createApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/no-head-session/commit",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().filesChanged).toBe(1);
    expect(git(repoDir, ["rev-list", "--count", "HEAD"]).trim()).toBe("1");
    expect(git(repoDir, ["log", "-1", "--pretty=%B"]).trim()).toBe("feat(init): create the first commit");
    expect(git(repoDir, ["status", "--short"]).trim()).toBe("");
  });

  it("prefers worktree_dir over project_dir", async () => {
    const { root, repoDir } = createCommittedRepo();
    const worktreeDir = join(root, "feature-worktree");
    git(repoDir, ["worktree", "add", "-b", "feature/commit-route", worktreeDir]);

    writeFileSync(join(repoDir, "project-only.js"), "export const projectOnly = true;\n");
    writeFileSync(join(worktreeDir, "app.js"), "export const base = 1;\nexport const worktreeOnly = true;\n");

    registerSession("worktree-session", {
      project_dir: repoDir,
      worktree_dir: worktreeDir,
    });
    anthropicResponses.push("feat(worktree): commit feature branch changes");
    const app = await createApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/worktree-session/commit",
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().filesChanged).toBe(1);
    expect(git(worktreeDir, ["log", "-1", "--pretty=%B"]).trim()).toBe("feat(worktree): commit feature branch changes");
    expect(git(repoDir, ["status", "--short"]).trim()).toContain("project-only.js");
    expect(anthropicCreateCalls[0].messages[0].content).toContain("worktreeOnly");
    expect(anthropicCreateCalls[0].messages[0].content).not.toContain("project-only.js");
  });

  it("truncates oversized diffs and respects the configured model", async () => {
    const { repoDir } = createCommittedRepo();
    const repeatedLines = Array.from({ length: 2_200 }, (_, index) => `line-${index} ${"x".repeat(20)}`).join("\n");
    writeFileSync(join(repoDir, "large.txt"), `${repeatedLines}\n`);

    registerSession("large-diff-session", {
      project_dir: repoDir,
    });
    process.env.DIFF_SUMMARY_MODEL = "claude-test-model";
    anthropicResponses.push("feat(server): summarize large diff");
    const app = await createApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/large-diff-session/commit",
    });

    expect(res.statusCode).toBe(200);
    expect(anthropicCreateCalls).toHaveLength(1);
    expect(anthropicCreateCalls[0].model).toBe("claude-test-model");
    expect(anthropicCreateCalls[0].messages[0].content).toContain("[diff truncated]");
  });

  it("returns 500 when the AI returns an empty commit message", async () => {
    const { repoDir } = createCommittedRepo();
    writeFileSync(join(repoDir, "app.js"), "export const base = 1;\nexport const updated = true;\n");

    registerSession("empty-message-session", {
      project_dir: repoDir,
    });
    anthropicResponses.push("   ");
    const app = await createApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/empty-message-session/commit",
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("empty commit message");
    expect(git(repoDir, ["status", "--short"]).trim()).not.toBe("");
  });

  const anthropicErrorCases = [
    { status: 429, message: "rate limit", expectedStatus: 429, expectedText: "Rate limited" },
    { status: 529, message: "overloaded", expectedStatus: 503, expectedText: "overloaded" },
    { status: 401, message: "unauthorized", expectedStatus: 502, expectedText: "configuration error" },
    { status: 500, message: "boom", expectedStatus: 502, expectedText: "boom" },
  ];

  for (const testCase of anthropicErrorCases) {
    it(`maps Anthropic status ${testCase.status} to the expected HTTP response`, async () => {
      const { repoDir } = createCommittedRepo();
      writeFileSync(join(repoDir, "app.js"), "export const base = 1;\nexport const changed = true;\n");

      registerSession(`error-session-${testCase.status}`, {
        project_dir: repoDir,
      });

      anthropicError = Object.assign(new Error(testCase.message), { status: testCase.status });
      const app = await createApp();

      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/error-session-${testCase.status}/commit`,
      });

      expect(res.statusCode).toBe(testCase.expectedStatus);
      expect(res.json().error).toContain(testCase.expectedText);
      expect(git(repoDir, ["status", "--short"]).trim()).not.toBe("");
    });
  }

  it("returns 500 when preview diff generation fails in a non-git directory", async () => {
    const dir = createExistingDirectory();
    registerSession("not-a-repo-session", {
      project_dir: dir,
    });
    const app = await createApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/not-a-repo-session/commit",
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("Git error");
    expect(anthropicCreateCalls).toHaveLength(0);
  });

  it("returns 500 when git commit fails after AI generation", async () => {
    const { repoDir } = createCommittedRepo();
    writeFileSync(join(repoDir, "app.js"), "export const base = 1;\nexport const changed = true;\n");

    registerSession("commit-failure-session", {
      project_dir: repoDir,
    });
    anthropicResponses.push("feat(server): try to commit");
    const app = await createInjectedApp({
      runGit: async (dir, args, options) => {
        if (args[0] === "commit") throw new Error("commit rejected");
        return actualRunGit(dir, args, options);
      },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/commit-failure-session/commit",
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toContain("Git commit failed: commit rejected");
    expect(anthropicCreateCalls).toHaveLength(1);
    expect(git(repoDir, ["status", "--short"]).trim()).not.toBe("");
  });

  it("commits submodule-only changes without false 'No changes to commit'", async () => {
    // Set up parent repo with a submodule using -c protocol.file.allow=always
    // to bypass git's local transport restrictions in test environments.
    const root = mkdtempSync(join(tmpdir(), "routes-commit-sub-"));
    tempRoots.push(root);

    // Create the "upstream" sub-repo
    const subRepo = join(root, "sub-repo");
    mkdirSync(subRepo);
    git(subRepo, ["init", "-b", "main"]);
    writeFileSync(join(subRepo, "lib.js"), "export const lib = true;\n");
    git(subRepo, ["add", "."]);
    git(subRepo, ["commit", "-m", "chore: init sub"]);

    // Create the parent repo and add the submodule
    const parentRepo = join(root, "parent");
    mkdirSync(parentRepo);
    git(parentRepo, ["init", "-b", "main"]);
    writeFileSync(join(parentRepo, "app.js"), "export const app = true;\n");
    git(parentRepo, ["add", "."]);
    git(parentRepo, ["commit", "-m", "chore: init parent"]);
    git(parentRepo, ["-c", "protocol.file.allow=always", "submodule", "add", subRepo, "packages/sub"]);
    git(parentRepo, ["commit", "-m", "chore: add submodule"]);

    // Make a change ONLY inside the submodule (no parent file changes)
    const subInParent = join(parentRepo, "packages/sub");
    writeFileSync(join(subInParent, "lib.js"), "export const lib = true;\nexport const updated = true;\n");

    registerSession("submodule-only-session", { project_dir: parentRepo });
    // Per-scope JSON messages for the multi-scope AI call
    anthropicResponses.push(
      JSON.stringify({
        "packages/sub": "fix(sub): update lib export",
        "parent": "chore: update submodule pointers",
      }),
    );
    const app = await createApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/submodule-only-session/commit",
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.submoduleCommits).toBeArrayOfSize(1);
    expect(body.submoduleCommits[0].name).toBe("packages/sub");
    // Submodule should be clean after commit
    expect(git(subInParent, ["status", "--short"]).trim()).toBe("");
    // Parent should be clean (submodule pointer was committed)
    expect(git(parentRepo, ["status", "--short"]).trim()).toBe("");
    expect(broadcastCalls).toEqual([{ type: "diff:invalidated", sessionId: "submodule-only-session" }]);
  });

  it("reuses the cached Anthropic client until resetClient is called", async () => {
    const { repoDir } = createCommittedRepo();
    registerSession("cache-session", {
      project_dir: repoDir,
    });
    const app = await createApp();

    anthropicResponses.push(
      "feat(server): first commit",
      "feat(server): second commit",
      "feat(server): third commit",
    );

    writeFileSync(join(repoDir, "app.js"), "export const base = 1;\nexport const first = true;\n");
    let res = await app.inject({
      method: "POST",
      url: "/api/sessions/cache-session/commit",
    });
    expect(res.statusCode).toBe(200);

    writeFileSync(join(repoDir, "app.js"), "export const base = 1;\nexport const first = true;\nexport const second = true;\n");
    res = await app.inject({
      method: "POST",
      url: "/api/sessions/cache-session/commit",
    });
    expect(res.statusCode).toBe(200);
    expect(anthropicConstructCalls).toHaveLength(1);

    resetClient();
    writeFileSync(join(repoDir, "app.js"), "export const base = 1;\nexport const first = true;\nexport const second = true;\nexport const third = true;\n");
    res = await app.inject({
      method: "POST",
      url: "/api/sessions/cache-session/commit",
    });
    expect(res.statusCode).toBe(200);
    expect(anthropicConstructCalls).toHaveLength(2);
  });
});
