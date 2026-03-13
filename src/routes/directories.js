/**
 * @module routes/directories
 * @description Lists directories under ~/Documents/code for the sidebar navigation.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CODE_DIR = process.env.PULSE_ROOT_DIR || join(homedir(), "Documents", "code");

/**
 * Fastify plugin for directory routes.
 *
 * @param {import("fastify").FastifyInstance} fastify - The Fastify instance.
 */
export default async function directoryRoutes(fastify) {
  fastify.get("/api/directories", async (_req, reply) => {
    try {
      const entries = readdirSync(CODE_DIR, { withFileTypes: true });
      const dirs = entries
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => ({
          name: e.name,
          path: join(CODE_DIR, e.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { directories: dirs, basePath: CODE_DIR };
    } catch (err) {
      reply.code(500);
      return { error: "Failed to list directories", message: err.message };
    }
  });
}
