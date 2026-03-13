/**
 * Architecture route — returns the project source tree and import graph
 * for visualization components.
 *
 * Endpoints:
 *   GET /api/sessions/:id/architecture — Source tree + import flow edges
 *
 * Delegates to `getArchitecture()` which scans the session's `project_dir`
 * for source files (max 400 files, depth 8), parses import statements
 * (ES/CJS/Python/Go), and builds a hierarchical tree with palette coloring.
 * Results are cached for 30s in memory.
 *
 * The response feeds `FractalArchitecture` and `MermaidArchitecture`
 * visualization components in the UI.
 *
 * @module routes/architecture
 */
import { getSession, lookupSessionId } from "../db.js";
import { getArchitecture } from "../architecture.js";

/**
 * Fastify plugin for architecture routes.
 *
 * @param {import("fastify").FastifyInstance} fastify - The Fastify instance.
 */
export default async function architectureRoutes(fastify) {
  fastify.get("/api/sessions/:id/architecture", async (req, reply) => {
    const sessionId = lookupSessionId(req.params.id);
    const session = getSession.get({ $id: sessionId });

    if (!session) {
      return reply.code(404).send({ error: "Session not found" });
    }

    const projectDir = session.project_dir;
    if (!projectDir || projectDir === "unknown") {
      return reply.code(400).send({ error: "Session has no project directory" });
    }

    try {
      const arch = await getArchitecture(projectDir);
      return { sessionId, projectDir, ...arch };
    } catch (err) {
      req.log.error(err, "Architecture scan failed");
      return reply.code(500).send({ error: "Failed to scan project architecture" });
    }
  });
}
