/**
 * @module routes/directories
 * @description Lists directories under ~/Documents/code for the sidebar navigation.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const CODE_DIR = process.env.CHORUS_ROOT_DIR || process.env.PULSE_ROOT_DIR || join(homedir(), "Documents", "code");
const DIRECTORY_CACHE_TTL_MS = 5_000;

let cachedResponse = null;
let cachedAt = 0;

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
    } catch (err) {
      reply.code(500);
      return { error: "Failed to list directories", message: err.message };
    }
  });
}
