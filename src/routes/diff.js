import { existsSync } from "node:fs";
import { getSession, lookupSessionId } from "../db.js";
import { parseDiffToFiles } from "../diff.js";
import { runGit } from "../run-git.js";

export default async function diffRoutes(fastify) {
  fastify.get("/api/sessions/:sessionId/diff", async (req, reply) => {
    const sessionId = lookupSessionId(req.params.sessionId);
    const session = getSession.get({ $id: sessionId });
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const dir = session.project_dir;
    if (!dir || dir === "unknown") {
      return reply.code(400).send({ error: "Session has no known working directory" });
    }

    if (!existsSync(dir)) {
      return reply.code(400).send({ error: `Working directory no longer exists: ${dir}` });
    }

    try {
      const diff = await runGit(dir, ["diff", "HEAD", "--no-color", "--unified=5"]);
      const stat = await runGit(dir, ["diff", "HEAD", "--stat", "--no-color"]);
      const branch = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);

      return {
        sessionId: req.params.sessionId,
        directory: dir,
        branch: branch.trim(),
        stat: stat.trim(),
        diff,
        files: parseDiffToFiles(diff),
      };
    } catch {
      // Fallback: repos with no commits yet
      try {
        const diff = await runGit(dir, ["diff", "--no-color", "--unified=5"]);
        const stat = await runGit(dir, ["diff", "--stat", "--no-color"]);
        return {
          sessionId: req.params.sessionId,
          directory: dir,
          branch: "unknown",
          stat: stat.trim(),
          diff,
          files: parseDiffToFiles(diff),
        };
      } catch (fallbackErr) {
        return reply.code(500).send({ error: `Git error: ${fallbackErr.message}` });
      }
    }
  });
}
