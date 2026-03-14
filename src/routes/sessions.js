import { broadcast, broadcastToSession } from "../broadcast.js";
import {
  upsertSession,
  updateSessionStatus,
  getSession,
  getAllSessions,
  resolveSessionId,
  lookupSessionId,
  deleteSession,
  insertAlias,
} from "../db.js";
import { isPromptActive, cancelPrompt, getActiveSwarmAgents, hasActiveSwarmAgents, cancelSwarmAgent } from "../prompt.js";
import { startWatching, stopWatching } from "../git-watcher.js";
import { invalidateDashboardSnapshot } from "../dashboard-snapshot.js";

/**
 * Fastify plugin for session lifecycle routes.
 * 
 * @param {import("fastify").FastifyInstance} fastify - Fastify instance
 */
export default async function sessionRoutes(fastify) {
  /**
   * Register or heartbeat a session.
   *
   * @route POST /api/sessions
   */
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
      sessionId = await resolveSessionId(claudeSessionId, projectDir);
    }

    const isAliasedToExisting = sessionId !== claudeSessionId;
    const existingSession = isAliasedToExisting ? getSession.get({ $id: sessionId }) : null;
    const isWorktree =
      existingSession &&
      existingSession.project_dir !== projectDir &&
      projectDir !== "unknown" &&
      // A subdirectory of project_dir is a submodule invocation, not a worktree.
      // Setting worktree_dir to a subdir would permanently misdirect diffs.
      !projectDir.startsWith(existingSession.project_dir + "/");

    // Clear stale worktree_dir when a non-worktree heartbeat arrives for a
    // session that previously had worktree_dir set (e.g., from a submodule
    // invocation that slipped through before this guard existed).
    const shouldClearWorktree =
      existingSession && !isWorktree && existingSession.worktree_dir;

    // Don't overwrite current_claude_session_id when a prompt subprocess is running
    const hasActivePrompt = isPromptActive(sessionId);

    upsertSession.run({
      $id: sessionId,
      $projectDir: isWorktree ? existingSession.project_dir : projectDir,
      $worktreeDir: isWorktree
        ? projectDir
          : shouldClearWorktree
            ? "__clear__"
            : (body.worktreeDir ?? null),
      $gitRoot: null,
      $status: "active",
      $model: body.model || null,
      $currentClaudeSessionId: hasActivePrompt ? null : claudeSessionId,
    });

    invalidateDashboardSnapshot();
    broadcast({ type: "session:updated", session: getSession.get({ $id: sessionId }) });

    // Start watching .git for changes (deduplicates by directory)
    const watchDir = isWorktree ? projectDir : (body.worktreeDir ?? projectDir);
    startWatching(sessionId, watchDir);

    // Notify UI about the swarm agent → session linkage
    if (swarmAgentId) {
      // Look up the parent session ID from the in-memory swarm agent registry
      const activeAgents = getActiveSwarmAgents();
      const swarmEntry = activeAgents.find((a) => a.id === swarmAgentId);
      const parentSessionId = swarmEntry?.sessionId ?? null;
      broadcastToSession(parentSessionId, {
        type: "swarm:session-linked",
        agentId: swarmAgentId,
        parentSessionId,
        dashboardSessionId: sessionId,
        claudeSessionId,
      });
    }

    return { ok: true };
  });

  /**
   * Mark a session as stopped.
   *
   * @route POST /api/sessions/:sessionId/stop
   */
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

      invalidateDashboardSnapshot();
      broadcast({ type: "session:updated", session: getSession.get({ $id: sessionId }) });
      return { ok: true };
    },
  });

  /**
   * List the 50 most recent sessions, ordered by last_seen_at descending.
   * 
   * @route GET /api/sessions
   */
  fastify.get("/api/sessions", async () => getAllSessions.all());

  /**
   * Force-delete a session and all associated data.
   *
   * @route DELETE /api/sessions/:sessionId
   */
  fastify.delete("/api/sessions/:sessionId", async (req, reply) => {
    const sessionId = lookupSessionId(req.params.sessionId);
    const session = getSession.get({ $id: sessionId });
    if (!session) {
      return reply.code(404).send({ error: "Session not found" });
    }

    // Force-stop active resources before deletion
    stopWatching(sessionId, session.worktree_dir || session.project_dir);
    cancelPrompt(sessionId);
    for (const agent of getActiveSwarmAgents(sessionId)) {
      cancelSwarmAgent(agent.id);
    }

    // Mark stopped so deleteSession() allows the DB cascade
    if (session.status === "active") {
      updateSessionStatus.run({ $id: sessionId, $status: "stopped" });
    }

    const deleted = deleteSession(sessionId);
    if (!deleted) {
      return reply.code(500).send({ error: "Failed to delete session" });
    }

    invalidateDashboardSnapshot();
    broadcast({ type: "session:deleted", sessionId });
    return { ok: true };
  });
}
