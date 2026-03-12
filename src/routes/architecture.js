import { getSession, lookupSessionId } from "../db.js";
import { getArchitecture } from "../architecture.js";

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
