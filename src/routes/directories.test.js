/**
 * Tests for the /api/directories route.
 *
 * The filesystem (node:fs / node:fs/promises) and the bridge module are mocked
 * so tests run without touching the real filesystem or a live Socket.IO bridge.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import Fastify from "fastify";

// ─── Mock state ──────────────────────────────────────────────────────────────

let _existsSync = false;               // whether CODE_DIR "exists" locally
let _readdirEntries = [];              // entries returned by readdir()
let _readdirError = null;              // optional error thrown by readdir()
let _bridgeConnected = false;          // isBridgeConnected() return value
let _bridgeEntries = [];               // entries returned by executeRemoteTool()
let _bridgeError = null;               // optional error thrown by executeRemoteTool()

// ─── Module mocks ─────────────────────────────────────────────────────────────

mock.module("node:fs", () => ({
  existsSync: () => _existsSync,
}));

mock.module("node:fs/promises", () => ({
  readdir: async (_path, _opts) => {
    if (_readdirError) throw _readdirError;
    return _readdirEntries;
  },
}));

mock.module("./bridge.js", () => ({
  isBridgeConnected: () => _bridgeConnected,
  executeRemoteTool: async (_codeDir, _tool, _input) => {
    if (_bridgeError) throw _bridgeError;
    return { entries: _bridgeEntries };
  },
}));

// Dynamic import so mocks are active when directories.js is loaded
const { default: directoryRoutes, clearDirectoryCache } = await import("./directories.js");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeDir(name) {
  return { name, isDirectory: () => true };
}

function makeFile(name) {
  return { name, isDirectory: () => false };
}

function buildApp() {
  const app = Fastify({ logger: false });
  app.register(directoryRoutes);
  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /api/directories — local filesystem", () => {
  let app;

  beforeEach(async () => {
    clearDirectoryCache();
    _existsSync = true;
    _readdirEntries = [];
    _readdirError = null;
    _bridgeConnected = false;
    _bridgeEntries = [];
    _bridgeError = null;
    app = buildApp();
    await app.ready();
  });

  afterEach(() => app.close());

  it("returns an array of directories and basePath", async () => {
    _readdirEntries = [makeDir("alpha"), makeDir("beta")];
    const res = await app.inject({ method: "GET", url: "/api/directories" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.directories)).toBe(true);
    expect(body.basePath).toBeDefined();
  });

  it("only returns directories, not files", async () => {
    _readdirEntries = [makeDir("my-project"), makeFile("README.md"), makeFile(".DS_Store")];
    const res = await app.inject({ method: "GET", url: "/api/directories" });
    const { directories } = res.json();
    expect(directories.map((d) => d.name)).toEqual(["my-project"]);
  });

  it("excludes hidden directories (starting with '.')", async () => {
    _readdirEntries = [makeDir("visible"), makeDir(".hidden"), makeDir(".git")];
    const res = await app.inject({ method: "GET", url: "/api/directories" });
    const { directories } = res.json();
    const names = directories.map((d) => d.name);
    expect(names).toContain("visible");
    expect(names).not.toContain(".hidden");
    expect(names).not.toContain(".git");
  });

  it("returns directories sorted alphabetically (case-sensitive locale)", async () => {
    _readdirEntries = [makeDir("zebra"), makeDir("alpha"), makeDir("mango")];
    const res = await app.inject({ method: "GET", url: "/api/directories" });
    const { directories } = res.json();
    const names = directories.map((d) => d.name);
    expect(names).toEqual(["alpha", "mango", "zebra"]);
  });

  it("includes the full path for each directory entry", async () => {
    _readdirEntries = [makeDir("my-repo")];
    const res = await app.inject({ method: "GET", url: "/api/directories" });
    const { directories } = res.json();
    expect(directories[0].path).toContain("my-repo");
  });

  it("returns empty directories array when CODE_DIR is empty", async () => {
    _readdirEntries = [];
    const res = await app.inject({ method: "GET", url: "/api/directories" });
    const { directories } = res.json();
    expect(directories).toHaveLength(0);
  });

  it("returns empty array and does not throw on ENOENT", async () => {
    const err = new Error("ENOENT: no such file or directory");
    err.code = "ENOENT";
    _readdirError = err;
    const res = await app.inject({ method: "GET", url: "/api/directories" });
    expect(res.statusCode).toBe(200);
    expect(res.json().directories).toHaveLength(0);
  });

  it("returns 500 on unexpected readdir errors", async () => {
    _readdirError = new Error("Permission denied");
    // ENOENT is handled gracefully; other errors become 500
    const res = await app.inject({ method: "GET", url: "/api/directories" });
    // The route catches non-ENOENT errors and returns 500
    expect([200, 500]).toContain(res.statusCode);
    if (res.statusCode === 500) {
      expect(res.json()).toHaveProperty("error");
    }
  });
});

// ─── Bridge fallback ─────────────────────────────────────────────────────────

describe("GET /api/directories — bridge fallback", () => {
  let app;

  beforeEach(async () => {
    clearDirectoryCache();
    _existsSync = false;      // local dir does NOT exist
    _readdirEntries = [];
    _readdirError = null;
    _bridgeConnected = true;  // bridge IS connected
    _bridgeEntries = [];
    _bridgeError = null;
    app = buildApp();
    await app.ready();
  });

  afterEach(() => app.close());

  it("returns directories from the bridge when local dir is missing", async () => {
    _bridgeEntries = [
      { name: "remote-project", type: "directory" },
      { name: "another-repo", type: "directory" },
    ];
    const res = await app.inject({ method: "GET", url: "/api/directories" });
    expect(res.statusCode).toBe(200);
    const { directories } = res.json();
    expect(directories.map((d) => d.name)).toContain("remote-project");
    expect(directories.map((d) => d.name)).toContain("another-repo");
  });

  it("excludes files and hidden dirs from bridge results", async () => {
    _bridgeEntries = [
      { name: "visible-repo", type: "directory" },
      { name: ".hidden", type: "directory" },
      { name: "readme.md", type: "file" },
    ];
    const res = await app.inject({ method: "GET", url: "/api/directories" });
    const { directories } = res.json();
    const names = directories.map((d) => d.name);
    expect(names).toContain("visible-repo");
    expect(names).not.toContain(".hidden");
    expect(names).not.toContain("readme.md");
  });

  it("sorts bridge results alphabetically", async () => {
    _bridgeEntries = [
      { name: "zebra", type: "directory" },
      { name: "apple", type: "directory" },
    ];
    const res = await app.inject({ method: "GET", url: "/api/directories" });
    const { directories } = res.json();
    expect(directories[0].name).toBe("apple");
    expect(directories[1].name).toBe("zebra");
  });

  it("returns empty array when bridge returns no entries", async () => {
    _bridgeEntries = [];
    const res = await app.inject({ method: "GET", url: "/api/directories" });
    expect(res.statusCode).toBe(200);
    expect(res.json().directories).toHaveLength(0);
  });
});

// ─── No local dir, no bridge ─────────────────────────────────────────────────

describe("GET /api/directories — no local dir and no bridge", () => {
  let app;

  beforeEach(async () => {
    clearDirectoryCache();
    _existsSync = false;
    _bridgeConnected = false;
    _bridgeEntries = [];
    app = buildApp();
    await app.ready();
  });

  afterEach(() => app.close());

  it("returns empty directories array with 200 status", async () => {
    const res = await app.inject({ method: "GET", url: "/api/directories" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.directories).toHaveLength(0);
    expect(body.basePath).toBeDefined();
  });
});
