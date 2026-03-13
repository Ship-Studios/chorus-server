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

import { broadcast } from "../broadcast.js";
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
 * @param {import('fastify').FastifyInstance} fastify
 */
export default async function swarmRoutes(fastify) {
  /**
   * POST /api/sessions/:sessionId/swarm/spawn
   *
   * Spawns an independent Claude Code agent attached to the given session.
   *
   * @body {string}  prompt          — The instruction for the agent (required)
   * @body {string}  [description]   — Human-readable label (defaults to first 80 chars of prompt)
   * @body {string}  [permissionMode] — One of: default, acceptEdits, bypassPermissions, plan, dontAsk
   * @body {string}  [model]         — Claude model override (validated against /^[a-zA-Z0-9._/-]+$/)
   * @body {boolean} [useWorktree]   — If true, run in an isolated git worktree branch
   * @body {object}  [image]         — Optional image attachment: { data: string (base64), mimeType: string }
   *
   * @returns {{ ok: true, agentId: string }}
   *
   * @throws {400} prompt missing or session has no working directory
   * @throws {404} session not found
   * @throws {429} MAX_SWARM_AGENTS limit reached
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
            broadcast({ type: "worktree:ready", worktree: worktreeRow, parentSessionId: sessionId });

            // Strip redundant worktree stats from swarm:done — the worktree:ready message
            // already carries the full record; clients don't need the raw stats twice.
            const { worktree: _discard, ...eventWithoutWorktree } = event;
            broadcast({ ...eventWithoutWorktree, parentSessionId: sessionId });
            broadcast({ type: "diff:invalidated", sessionId });
            return; // Don't fall through to the generic broadcast
          }

          // Swarm agent completed — may have modified files
          if (event.type === "swarm:done") {
            broadcast({ type: "diff:invalidated", sessionId });
          }
          broadcast({ ...event, parentSessionId: sessionId });
        },
      ));
    } catch (err) {
      if (err.message.startsWith("Maximum concurrent swarm agents")) {
        return reply.code(429).send({ error: err.message });
      }
      throw err;
    }

    broadcast({ type: "swarm:spawned", agentId, parentSessionId: sessionId, description: agentDescription, startedAt: Date.now(), worktree: !!useWorktree });
    return { ok: true, agentId };
  });

  /**
   * POST /api/swarm/:agentId/cancel
   *
   * Sends SIGTERM to a running swarm agent (escalates to SIGKILL after 3s).
   * Does NOT broadcast `swarm:done` — the process close handler in
   * swarm-manager.js is the single source of truth and emits it with
   * `cancelled: true` once the process actually exits.
   *
   * @returns {{ ok: true, cancelled: boolean }}
   */
  fastify.post("/api/swarm/:agentId/cancel", async (req) => {
    const { cancelled } = cancelSwarmAgent(req.params.agentId);
    return { ok: true, cancelled };
  });

  /**
   * GET /api/sessions/:sessionId/swarm
   *
   * Lists active (in-memory) swarm agents for a session. Only includes agents
   * whose processes are still running — completed agents are not retained.
   *
   * @returns {Array<{ id: string, description: string, startedAt: number, status: string }>}
   */
  fastify.get("/api/sessions/:sessionId/swarm", async (req) => {
    const sessionId = lookupSessionId(req.params.sessionId);
    return getActiveSwarmAgents(sessionId);
  });
}
