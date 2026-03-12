import { broadcast } from "../broadcast.js";
import {
  upsertSession,
  updateSessionStatus,
  getAllSessions,
  getSession,
  resolveSessionId,
  lookupSessionId,
  deleteSession,
  insertAlias,
} from "../db.js";
import { isPromptActive } from "../prompt.js";

export default async function sessionRoutes(fastify) {
  fastify.post("/api/sessions", async (req, reply) => {
    const body = req.body ?? {};
    const claudeSessionId = body.sessionId;
    const projectDir = body.projectDir || "unknown";
    const swarmAgentId = body.agentId || null;

    if (!claudeSessionId) {
      return reply.code(400).send({ error: "sessionId is required" });
    }

    // When a swarm agent panel sends its agentId, force a new session
    // (skip alias resolution which would merge it into the parent session).
    let sessionId;
    if (swarmAgentId) {
      sessionId = claudeSessionId;
      insertAlias.run({
        $claudeSessionId: claudeSessionId,
        $dashboardSessionId: claudeSessionId,
      });
    } else {
      sessionId = resolveSessionId(claudeSessionId, projectDir);
    }

    const isAliasedToExisting = sessionId !== claudeSessionId;
    const existingSession = isAliasedToExisting ? getSession.get({ $id: sessionId }) : null;
    const isWorktree =
      existingSession &&
      existingSession.project_dir !== projectDir &&
      projectDir !== "unknown";

    // Don't overwrite current_claude_session_id when a prompt subprocess is running
    const hasActivePrompt = isPromptActive(sessionId);

    upsertSession.run({
      $id: sessionId,
      $projectDir: isWorktree ? existingSession.project_dir : projectDir,
      $worktreeDir: isWorktree ? projectDir : (body.worktreeDir ?? null),
      $status: "active",
      $model: body.model || null,
      $currentClaudeSessionId: hasActivePrompt ? null : claudeSessionId,
    });

    broadcast({ type: "sessions:update", sessions: getAllSessions.all() });

    // Notify UI about the swarm agent → session linkage
    if (swarmAgentId) {
      broadcast({
        type: "swarm:session-linked",
        agentId: swarmAgentId,
        dashboardSessionId: sessionId,
        claudeSessionId,
      });
    }

    return { ok: true };
  });

  fastify.post("/api/sessions/:sessionId/stop", {
    config: { rawBody: true },
    handler: async (req, reply) => {
      const sessionId = lookupSessionId(req.params.sessionId);

      // Ignore stop from prompt subprocess — real session is still alive
      if (isPromptActive(sessionId)) {
        return { ok: true, ignored: true };
      }

      try {
        updateSessionStatus.run({ $id: sessionId, $status: "stopped" });
      } catch {
        console.log(`Session ${sessionId} not found for stop, ignoring`);
      }

      broadcast({ type: "sessions:update", sessions: getAllSessions.all() });
      return { ok: true };
    },
  });

  fastify.get("/api/sessions", async () => getAllSessions.all());

  fastify.delete("/api/sessions/:sessionId", async (req, reply) => {
    const sessionId = lookupSessionId(req.params.sessionId);
    const deleted = deleteSession(sessionId);
    if (!deleted) {
      return reply.code(400).send({ error: "Session not found or still active" });
    }

    broadcast({ type: "sessions:update", sessions: getAllSessions.all() });
    return { ok: true };
  });
}
