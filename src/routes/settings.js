/**
 * Settings routes — runtime configuration for API keys, models, and preferences.
 *
 * Endpoints:
 *   GET    /api/settings              — List all settings (secrets redacted)
 *   PUT    /api/settings              — Create or update a setting
 *   DELETE /api/settings/:key         — Delete a setting
 *   GET    /api/settings/test-anthropic — Test the current Anthropic API key
 *
 * Settings priority: env var > database > default
 * Secret values are redacted in GET responses (first 8 chars + ****)
 *
 * @module routes/settings
 */
import { getAllSettings, upsertSetting, deleteSetting } from "../db-adapter.js";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicFetchOptions } from "../vpn.js";

// Known settings with metadata
const SETTING_DEFS = {
  ANTHROPIC_API_KEY:        { secret: true,  default: null,                        category: "API Keys",  label: "Anthropic API Key" },
  MOBEY_API_KEY:            { secret: true,  default: null,                        category: "API Keys",  label: "Mobey API Key" },
  DIFF_SUMMARY_MODEL:       { secret: false, default: "claude-haiku-4-5-20251001", category: "Models",    label: "Diff Summary Model" },
  FLINT_CONSULTANT_MODEL:   { secret: false, default: "claude-sonnet-4-6",         category: "Models",    label: "Flint Consultant Model" },
  CRAFTING_SYNTHESIS_MODEL: { secret: false, default: "claude-sonnet-4-6",         category: "Models",    label: "Crafting Synthesis Model" },
};

// Track original env values at startup so we can detect env-sourced settings
const startupEnv = {};
for (const key of Object.keys(SETTING_DEFS)) {
  if (process.env[key]) startupEnv[key] = process.env[key];
}

function redact(value) {
  if (!value) return null;
  if (value.length <= 8) return "****";
  return value.slice(0, 8) + "****";
}

function getSource(key, dbRow) {
  if (startupEnv[key]) return "env";
  if (dbRow) return "database";
  return "default";
}

function getEffectiveValue(key, dbRow) {
  return startupEnv[key] || dbRow?.value || SETTING_DEFS[key]?.default || null;
}

export default async function settingsRoutes(fastify) {

  // GET /api/settings — list all with redaction
  fastify.get("/api/settings", async () => {
    const dbRows = await getAllSettings();
    const dbMap = new Map(dbRows.map(r => [r.key, r]));

    const settings = {};
    for (const [key, def] of Object.entries(SETTING_DEFS)) {
      const dbRow = dbMap.get(key);
      const effectiveValue = getEffectiveValue(key, dbRow);
      const source = getSource(key, dbRow);
      settings[key] = {
        value: def.secret ? redact(effectiveValue) : effectiveValue,
        source,
        redacted: def.secret,
        category: def.category,
        label: def.label,
        updatedAt: dbRow?.updated_at ?? null,
      };
    }
    return { settings };
  });

  // PUT /api/settings — upsert a setting
  fastify.put("/api/settings", async (req, reply) => {
    const { key, value } = req.body ?? {};
    if (!key || value === undefined) return reply.code(400).send({ error: "key and value are required" });
    if (!SETTING_DEFS[key]) return reply.code(400).send({ error: `Unknown setting: ${key}` });

    const encrypted = SETTING_DEFS[key].secret;
    await upsertSetting(key, value, encrypted);

    // Patch process.env so the change takes effect immediately
    process.env[key] = value;

    // If ANTHROPIC_API_KEY changed, reset cached Anthropic clients
    if (key === "ANTHROPIC_API_KEY") {
      // Import resetClient functions dynamically to avoid circular deps
      try {
        const { resetClient: resetDiffSummary } = await import("./diff-summary.js");
        const { resetClient: resetCommit } = await import("./commit.js");
        const { resetClient: resetCrafting } = await import("./crafting.js");
        const { resetClient: resetFlint } = await import("./flint.js");
        resetDiffSummary();
        resetCommit();
        resetCrafting();
        resetFlint();
      } catch { /* non-critical */ }
    }

    return { ok: true, key };
  });

  // DELETE /api/settings/:key — remove a setting
  fastify.delete("/api/settings/:key", async (req, reply) => {
    const { key } = req.params;
    if (!SETTING_DEFS[key]) return reply.code(400).send({ error: `Unknown setting: ${key}` });

    await deleteSetting(key);

    // Revert to env var or clear
    if (startupEnv[key]) {
      process.env[key] = startupEnv[key];
    } else {
      delete process.env[key];
    }

    return { ok: true };
  });

  // GET /api/settings/test-anthropic — test the API key
  fastify.get("/api/settings/test-anthropic", async (req, reply) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return reply.code(400).send({ ok: false, error: "No ANTHROPIC_API_KEY configured" });

    try {
      const fetchOptions = getAnthropicFetchOptions();
      const client = new Anthropic({ apiKey, ...fetchOptions });
      const msg = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      });
      return { ok: true, model: msg.model };
    } catch (err) {
      return reply.code(200).send({ ok: false, error: err.message });
    }
  });
}
