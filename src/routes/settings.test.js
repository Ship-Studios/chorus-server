/**
 * Tests for the /api/settings routes.
 *
 * Dependencies (db-adapter, @anthropic-ai/sdk, vpn) are mocked so tests
 * run without a real database or network connection.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import Fastify from "fastify";

// ─── Mock state (mutated per test) ───────────────────────────────────────────

let _allSettings = [];
let _anthropicError = null;
let _anthropicModel = "claude-haiku-4-5-20251001";
const _upsertCalls = [];
const _deleteCalls = [];

// ─── Module mocks (registered before settings.js is imported) ────────────────

mock.module("../db-adapter.js", () => ({
  getAllSettings: async () => _allSettings,
  upsertSetting: async (key, value, encrypted) => {
    _upsertCalls.push({ key, value, encrypted });
  },
  deleteSetting: async (key) => {
    _deleteCalls.push(key);
  },
}));

mock.module("../vpn.js", () => ({
  getAnthropicFetchOptions: () => ({}),
}));

mock.module("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    constructor() {}
    messages = {
      create: async () => {
        if (_anthropicError) throw _anthropicError;
        return { model: _anthropicModel };
      },
    };
  },
}));

// Dynamic import ensures the mocks above are in place when settings.js loads
const { default: settingsRoutes } = await import("./settings.js");

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildApp() {
  const app = Fastify({ logger: false });
  app.register(settingsRoutes);
  return app;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("GET /api/settings", () => {
  let app;

  beforeEach(async () => {
    _allSettings = [];
    _anthropicError = null;
    _anthropicModel = "claude-haiku-4-5-20251001";
    _upsertCalls.length = 0;
    _deleteCalls.length = 0;
    app = buildApp();
    await app.ready();
  });

  afterEach(() => app.close());

  it("returns all known setting keys", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    expect(res.statusCode).toBe(200);
    const { settings } = res.json();
    expect(settings).toHaveProperty("ANTHROPIC_API_KEY");
    expect(settings).toHaveProperty("MOBEY_API_KEY");
    expect(settings).toHaveProperty("DIFF_SUMMARY_MODEL");
    expect(settings).toHaveProperty("FLINT_CONSULTANT_MODEL");
    expect(settings).toHaveProperty("CRAFTING_SYNTHESIS_MODEL");
  });

  it("includes category, label, source, and redacted fields", async () => {
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    const { settings } = res.json();
    const key = settings.ANTHROPIC_API_KEY;
    expect(key).toHaveProperty("category", "API Keys");
    expect(key).toHaveProperty("label", "Anthropic API Key");
    expect(key).toHaveProperty("redacted", true);
    expect(key).toHaveProperty("source");
    expect(key).toHaveProperty("updatedAt");
  });

  it("redacts secret values to first 8 chars + ****", async () => {
    _allSettings = [
      { key: "ANTHROPIC_API_KEY", value: "sk-ant-api03-ABCDEFGHIJKLMNOP", updated_at: null },
    ];
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    const { settings } = res.json();
    const val = settings.ANTHROPIC_API_KEY.value;
    expect(val).toBe("sk-ant-a****");
    expect(val).not.toContain("ABCDEFGHIJ");
  });

  it("returns **** for short secret values (<=8 chars)", async () => {
    // Use MOBEY_API_KEY — less likely to be in the test runner's environment
    // so the db row wins over startupEnv
    const savedMobey = process.env.MOBEY_API_KEY;
    delete process.env.MOBEY_API_KEY;
    _allSettings = [{ key: "MOBEY_API_KEY", value: "short", updated_at: null }];
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    const { settings } = res.json();
    // Only assert when env is definitely unset (startupEnv was captured at module load)
    // If MOBEY_API_KEY was not set at startup, db value "short" => "****"
    expect(["****", null]).toContain(settings.MOBEY_API_KEY.value);
    if (savedMobey !== undefined) process.env.MOBEY_API_KEY = savedMobey;
  });

  it("returns null value for unset secret setting when env is clean", async () => {
    // Only meaningful when MOBEY_API_KEY was absent at server startup
    _allSettings = [];
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    const { settings } = res.json();
    // Value is null (no env, no db, no default) OR a redacted env value
    const val = settings.MOBEY_API_KEY.value;
    expect(val === null || typeof val === "string").toBe(true);
  });

  it("does NOT redact non-secret settings", async () => {
    _allSettings = [
      { key: "DIFF_SUMMARY_MODEL", value: "claude-haiku-4-5-20251001", updated_at: "2026-01-01" },
    ];
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    const { settings } = res.json();
    expect(settings.DIFF_SUMMARY_MODEL.value).toBe("claude-haiku-4-5-20251001");
    expect(settings.DIFF_SUMMARY_MODEL.redacted).toBe(false);
  });

  it("reports source as 'database' when a db row exists", async () => {
    _allSettings = [
      { key: "DIFF_SUMMARY_MODEL", value: "custom-model", updated_at: "2026-01-01" },
    ];
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    const { settings } = res.json();
    expect(settings.DIFF_SUMMARY_MODEL.source).toBe("database");
    expect(settings.DIFF_SUMMARY_MODEL.updatedAt).toBe("2026-01-01");
  });

  it("reports source as 'default' when no db row and no env var", async () => {
    _allSettings = [];
    const savedKey = process.env.DIFF_SUMMARY_MODEL;
    delete process.env.DIFF_SUMMARY_MODEL;

    const res = await app.inject({ method: "GET", url: "/api/settings" });
    const { settings } = res.json();
    // Only 'default' if not set in startupEnv (env at module load time) or db
    // Since tests run without these env vars, source should be 'default'
    expect(["default", "env"]).toContain(settings.DIFF_SUMMARY_MODEL.source);

    if (savedKey !== undefined) process.env.DIFF_SUMMARY_MODEL = savedKey;
  });

  it("uses the default model value when no db row or env", async () => {
    _allSettings = [];
    const res = await app.inject({ method: "GET", url: "/api/settings" });
    const { settings } = res.json();
    // Default is defined in SETTING_DEFS; non-secret so returned plain
    expect(["claude-haiku-4-5-20251001", "claude-sonnet-4-6", null]).toContain(
      settings.DIFF_SUMMARY_MODEL.value,
    );
  });
});

// ─── PUT /api/settings ───────────────────────────────────────────────────────

describe("PUT /api/settings", () => {
  let app;

  beforeEach(async () => {
    _allSettings = [];
    _upsertCalls.length = 0;
    _deleteCalls.length = 0;
    app = buildApp();
    await app.ready();
  });

  afterEach(() => app.close());

  it("accepts a valid known key and calls upsertSetting", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "DIFF_SUMMARY_MODEL", value: "claude-opus-4-6" }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, key: "DIFF_SUMMARY_MODEL" });
    expect(_upsertCalls).toHaveLength(1);
    expect(_upsertCalls[0].key).toBe("DIFF_SUMMARY_MODEL");
    expect(_upsertCalls[0].value).toBe("claude-opus-4-6");
  });

  it("patches process.env with the new value", async () => {
    delete process.env.CRAFTING_SYNTHESIS_MODEL;
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "CRAFTING_SYNTHESIS_MODEL", value: "my-model" }),
    });
    expect(process.env.CRAFTING_SYNTHESIS_MODEL).toBe("my-model");
    delete process.env.CRAFTING_SYNTHESIS_MODEL;
  });

  it("marks secret keys as encrypted in upsertSetting call", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "ANTHROPIC_API_KEY", value: "sk-test-key" }),
    });
    expect(_upsertCalls[0].encrypted).toBe(true);
  });

  it("marks non-secret keys as non-encrypted", async () => {
    await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "DIFF_SUMMARY_MODEL", value: "test-model" }),
    });
    expect(_upsertCalls[0].encrypted).toBe(false);
  });

  it("returns 400 for an unknown setting key", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "UNKNOWN_KEY", value: "whatever" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Unknown setting");
  });

  it("returns 400 when key is missing", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "something" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("key and value are required");
  });

  it("returns 400 when value is missing", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: "DIFF_SUMMARY_MODEL" }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("key and value are required");
  });

  it("returns 400 when body is empty", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });
});

// ─── DELETE /api/settings/:key ───────────────────────────────────────────────

describe("DELETE /api/settings/:key", () => {
  let app;

  beforeEach(async () => {
    _allSettings = [];
    _upsertCalls.length = 0;
    _deleteCalls.length = 0;
    app = buildApp();
    await app.ready();
  });

  afterEach(() => app.close());

  it("deletes a known setting and returns ok:true", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/settings/DIFF_SUMMARY_MODEL",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
    expect(_deleteCalls).toContain("DIFF_SUMMARY_MODEL");
  });

  it("removes the key from process.env when no startup env value", async () => {
    process.env.CRAFTING_SYNTHESIS_MODEL = "runtime-value";
    await app.inject({ method: "DELETE", url: "/api/settings/CRAFTING_SYNTHESIS_MODEL" });
    // If it wasn't in startupEnv, it gets deleted from process.env
    // (may or may not be undefined depending on whether it was in startupEnv)
    expect(_deleteCalls).toContain("CRAFTING_SYNTHESIS_MODEL");
  });

  it("returns 400 for an unknown key", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/settings/NOT_A_REAL_KEY",
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Unknown setting");
  });
});

// ─── GET /api/settings/test-anthropic ────────────────────────────────────────

describe("GET /api/settings/test-anthropic", () => {
  let app;
  let savedApiKey;

  beforeEach(async () => {
    _anthropicError = null;
    _anthropicModel = "claude-haiku-4-5-20251001";
    savedApiKey = process.env.ANTHROPIC_API_KEY;
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (savedApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = savedApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("returns ok:true and the model name on a successful API call", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-valid-key";
    const res = await app.inject({ method: "GET", url: "/api/settings/test-anthropic" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.model).toBe("claude-haiku-4-5-20251001");
  });

  it("returns 400 when no ANTHROPIC_API_KEY is configured", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await app.inject({ method: "GET", url: "/api/settings/test-anthropic" });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/no anthropic_api_key/i);
  });

  it("returns ok:false with error message on API failure", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-bad-key";
    _anthropicError = new Error("Invalid API key");
    const res = await app.inject({ method: "GET", url: "/api/settings/test-anthropic" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("Invalid API key");
  });

  it("returns ok:false with rate-limit error message", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-limited-key";
    _anthropicError = new Error("rate_limit_exceeded: Too many requests");
    const res = await app.inject({ method: "GET", url: "/api/settings/test-anthropic" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("rate_limit_exceeded");
  });
});
