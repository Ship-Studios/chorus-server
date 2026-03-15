/**
 * routes/user-settings.js — Per-user settings CRUD (multi-user mode).
 *
 * These endpoints are only meaningful in multi-user mode. In single-user mode
 * they return empty/404 since there is no user context.
 *
 * Endpoints:
 *   GET    /api/user/settings        — List all settings for the current user
 *   PUT    /api/user/settings        — Create or update a user setting
 *   DELETE /api/user/settings/:key   — Delete a user setting
 */

import { isMultiUserMode } from "../auth.js";
import { getUserSettings, upsertUserSetting, deleteUserSetting } from "../db-adapter.js";

/** Setting keys that should be redacted in API responses. */
const SECRET_KEYS = new Set(["ANTHROPIC_API_KEY"]);

function redactValue(key, value) {
  if (SECRET_KEYS.has(key) && value && value.length > 8) {
    return value.slice(0, 8) + "****";
  }
  return value;
}

export default async function userSettingsRoutes(app) {
  app.get("/api/user/settings", async (request, reply) => {
    if (!isMultiUserMode() || !request.user) {
      return { settings: [] };
    }

    const rows = await getUserSettings(request.user.id);
    return {
      settings: rows.map((row) => ({
        key: row.key,
        value: redactValue(row.key, row.value),
        encrypted: !!row.encrypted,
        updatedAt: row.updated_at,
        source: "user",
      })),
    };
  });

  app.put("/api/user/settings", async (request, reply) => {
    if (!isMultiUserMode() || !request.user) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const { key, value } = request.body ?? {};
    if (!key || value === undefined) {
      return reply.code(400).send({ error: "key and value are required" });
    }

    const encrypted = SECRET_KEYS.has(key);
    await upsertUserSetting({
      userId: request.user.id,
      key,
      value: String(value),
      encrypted,
    });

    return { ok: true, key, source: "user" };
  });

  app.delete("/api/user/settings/:key", async (request, reply) => {
    if (!isMultiUserMode() || !request.user) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    await deleteUserSetting(request.user.id, request.params.key);
    return { ok: true };
  });
}
