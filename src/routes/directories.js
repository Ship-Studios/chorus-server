/**
 * @module routes/directories
 * @description Lists directories under ~/Documents/code for the sidebar navigation.
 * Falls back to the bridge when the directory doesn't exist locally (Railway deployment).
 */

import { readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { executeRemoteTool, isBridgeConnected } from "./bridge.js";

const CODE_DIR = process.env.CHORUS_ROOT_DIR || join(homedir(), "Documents", "code");
const DIRECTORY_CACHE_TTL_MS = 5_000;

let cachedResponse = null;
let cachedAt = 0;

/** Reset the in-memory cache. Exported for use in tests only. */
export function clearDirectoryCache() {
  cachedResponse = null;
  cachedAt = 0;
}

/**
 * Fastify plugin for directory routes.
 *
 * @param {import("fastify").FastifyInstance} fastify - The Fastify instance.
 */
export default async function directoryRoutes(fastify) {
  fastify.get("/api/directories", async (_req, reply) => {
    try {
      if (cachedResponse && Date.now() - cachedAt < DIRECTORY_CACHE_TTL_MS) {
        return cachedResponse;
      }

      // Try local filesystem first
      if (existsSync(CODE_DIR)) {
        const entries = await readdir(CODE_DIR, { withFileTypes: true });
        const dirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => ({
            name: e.name,
            path: join(CODE_DIR, e.name),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        cachedResponse = { directories: dirs, basePath: CODE_DIR };
        cachedAt = Date.now();
        return cachedResponse;
      }

      // Directory doesn't exist locally — try bridge
      if (isBridgeConnected(CODE_DIR)) {
        const result = await executeRemoteTool(CODE_DIR, "fs_list", { path: CODE_DIR });
        const dirs = (result.entries || [])
          .filter((e) => e.type === "directory" && !e.name.startsWith("."))
          .map((e) => ({
            name: e.name,
            path: join(CODE_DIR, e.name),
          }))
          .sort((a, b) => a.name.localeCompare(b.name));

        cachedResponse = { directories: dirs, basePath: CODE_DIR };
        cachedAt = Date.now();
        return cachedResponse;
      }

      // No local dir and no bridge — return empty but don't cache
      // (bridge may connect shortly after server start)
      return { directories: [], basePath: CODE_DIR };
    } catch (err) {
      if (err.code === "ENOENT") {
        return { directories: [], basePath: CODE_DIR };
      }
      reply.code(500);
      return { error: "Failed to list directories", message: err.message };
    }
  });
}
