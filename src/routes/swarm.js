/**
 * Swarm agent routes — spawn, cancel, and list independent Claude Code agents.
 *
 * Endpoints:
 *   POST /api/sessions/:sessionId/swarm/spawn  — Spawn a new swarm agent
 *   POST /api/swarm/:agentId/cancel             — Cancel a running swarm agent
 *   GET  /api/sessions/:sessionId/swarm          — List active swarm agents for a session
 *
 * Swarm agents are fresh `claude --print` processes (not `--resume`) that run
 * independently of the parent session. They self-register as their own dashboard
 * sessions via hooks. An optional worktree mode isolates file changes in a
 * dedicated git branch so the main working tree is unaffected.
 *
 * Concurrency is capped at MAX_SWARM_AGENTS (default 10); exceeding returns 429.
 *
 * @module routes/swarm
 * @see {@link ../swarm-manager.js} for process lifecycle and worktree isolation
 * @see {@link ../git-worktree.js} for git worktree create/remove/diff utilities
 */

import { broadcastToSession, debouncedDiffInvalidation } from "../broadcast.js";
import {
  getSession,
  lookupSessionId,
  insertWorktree,
  updateWorktreeStats,
  updateWorktreeConflicts,
  getWorktree,
} from "../db.js";
import { spawnSwarmAgent, cancelSwarmAgent, getActiveSwarmAgents } from "../prompt.js";

/** Body size limit for spawn requests — 15 MB to accommodate base64-encoded images. */
const SPAWN_BODY_LIMIT = 15 * 1024 * 1024;

/**
 * Registers swarm agent routes on the Fastify instance.
 *
 * @param {import('fastify').FastifyInstance} fastify - Fastify instance
 */
export default async function swarmRoutes(fastify) {
  /**
   * Spawns an independent Claude Code agent attached to the given session.
   * 
   * @route POST /api/sessions/:sessionId/swarm/spawn
   * @param {import("fastify").FastifyRequest} req - Fastify request
   * @param {import("fastify").FastifyReply} reply - Fastify reply
   * @returns {Promise<{ ok: boolean, agentId: string }>}
   */
  fastify.post("/api/sessions/:sessionId/swarm/spawn", { bodyLimit: SPAWN_BODY_LIMIT }, async (req, reply) => {
    const { prompt, description, permissionMode, model, useWorktree, image } = req.body ?? {};
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });

    const sessionId = lookupSessionId(req.params.sessionId);
    const session = getSession.get({ $id: sessionId });
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const baseCwd = session.worktree_dir || session.project_dir;
    if (!baseCwd || baseCwd === "unknown") {
      return reply.code(400).send({ error: "Session has no known working directory" });
    }

    const agentDescription = description || prompt.slice(0, 80);

    let agentId;
    try {
      ({ id: agentId } = await spawnSwarmAgent(
        { prompt, cwd: baseCwd, description: agentDescription, permissionMode, model, parentSessionId: sessionId, useWorktree: !!useWorktree, image: image || undefined },
        /**
         * Event callback invoked by swarm-manager for each lifecycle event.
         * Handles two completion paths:
         *
         * 1. **Worktree agent done** (`swarm:done` + `event.worktree`):
         *    Persists the worktree record to DB with diff stats, detects conflicts,
         *    broadcasts `worktree:ready`, then strips redundant worktree data from
         *    the `swarm:done` event before broadcasting it separately.
         *
         * 2. **Non-worktree agent done** (`swarm:done` without worktree):
         *    Broadcasts `diff:invalidated` (files may have changed in main tree)
         *    followed by the `swarm:done` event.
         *
         * All other events (swarm:chunk, swarm:spawned, etc.) are broadcast
         * directly with `parentSessionId` attached.
         */
        (event) => {
          // When a worktree agent finishes, persist the record to DB
          if (event.type === "swarm:done" && event.worktree) {
            const wt = event.worktree;
            const status = wt.filesChanged > 0 ? "ready" : "empty";

            const { id: worktreeDbId } = insertWorktree.get({
              $sessionId: sessionId,
              $branchName: wt.branchName,
              $baseBranch: wt.baseBranch,
              $description: agentDescription,
              $agentId: event.agentId,
              $status: status,
            });

            updateWorktreeStats.run({
              $id: worktreeDbId,
              $filesChanged: wt.filesChanged,
              $insertions: wt.insertions,
              $deletions: wt.deletions,
              $diffStat: wt.diffStat,
              $status: status,
            });

            if (wt.conflictInfo) {
              updateWorktreeConflicts.run({ $id: worktreeDbId, $conflictInfo: wt.conflictInfo });
            }

            const worktreeRow = getWorktree.get({ $id: worktreeDbId });
            broadcastToSession(sessionId, { type: "worktree:ready", worktree: worktreeRow, parentSessionId: sessionId });

            // Strip redundant worktree stats from swarm:done — the worktree:ready message
            // already carries the full record; clients don't need the raw stats twice.
            const { worktree: _discard, ...eventWithoutWorktree } = event;
            broadcastToSession(sessionId, { ...eventWithoutWorktree, parentSessionId: sessionId });
            debouncedDiffInvalidation(sessionId);
            return; // Don't fall through to the generic broadcast
          }

          // Swarm agent completed — may have modified files
          if (event.type === "swarm:done") {
            debouncedDiffInvalidation(sessionId);
          }
          broadcastToSession(sessionId, { ...event, parentSessionId: sessionId });
        },
      ));
    } catch (err) {
      if (err.message.startsWith("Maximum concurrent swarm agents")) {
        return reply.code(429).send({ error: err.message });
      }
      throw err;
    }

    broadcastToSession(sessionId, { type: "swarm:spawned", agentId, parentSessionId: sessionId, description: agentDescription, startedAt: Date.now(), worktree: !!useWorktree });
    return { ok: true, agentId };
  });

  /**
   * Sends SIGTERM to a running swarm agent (escalates to SIGKILL after 3s).
   * 
   * @route POST /api/swarm/:agentId/cancel
   * @param {import("fastify").FastifyRequest} req - Fastify request
   * @returns {Promise<{ ok: boolean, cancelled: boolean }>}
   */
  fastify.post("/api/swarm/:agentId/cancel", async (req) => {
    const { cancelled } = cancelSwarmAgent(req.params.agentId);
    return { ok: true, cancelled };
  });

  /**
   * Lists active (in-memory) swarm agents for a session.
   * 
   * @route GET /api/sessions/:sessionId/swarm
   * @param {import("fastify").FastifyRequest} req - Fastify request
   * @returns {Promise<Array<import("../prompt.js").SwarmAgent>>}
   */
  fastify.get("/api/sessions/:sessionId/swarm", async (req) => {
    const sessionId = lookupSessionId(req.params.sessionId);
    return getActiveSwarmAgents(sessionId);
  });
}
