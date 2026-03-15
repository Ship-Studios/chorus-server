/**
 * Swarm agent routes — spawn, cancel, and list independent Claude Code agents.
 *
 * Endpoints:
 *   POST /api/sessions/:sessionId/swarm/spawn  — Spawn a new swarm agent via bridge
 *   POST /api/swarm/:agentId/cancel             — Cancel a running swarm agent
 *   GET  /api/sessions/:sessionId/swarm          — List active swarm agents for a session
 *
 * Swarm agents are dispatched to the local-agent daemon over the /bridge Socket.IO
 * namespace. The daemon runs Agent SDK processes locally and streams lifecycle
 * events (swarm:spawned, swarm:chunk, swarm:done) back through the bridge.
 *
 * Worktree isolation and commit handling happen on the daemon side.
 *
 * Concurrency is capped at MAX_SWARM_AGENTS (default 10); exceeding returns 429.
 * If no local agent daemon is connected for the session's project, returns 503.
 *
 * @module routes/swarm
 */

import { randomUUID } from "node:crypto";
import { broadcastToSession } from "../broadcast.js";
import { getSession } from "../db-adapter.js";
import { lookupSessionId } from "../session-resolver.js";
import {
  dispatchSwarmToBridge,
  cancelSwarmAgent,
  getActiveSwarmAgents,
  trackSwarmAgent,
  isBridgeConnected,
} from "../prompt-adapter.js";

/** Body size limit for spawn requests — 15 MB to accommodate base64-encoded images. */
const SPAWN_BODY_LIMIT = 15 * 1024 * 1024;

/** Maximum concurrent swarm agents (matches old MAX_SWARM_AGENTS). */
const MAX_SWARM_AGENTS = parseInt(process.env.MAX_SWARM_AGENTS || "10", 10);

/** Model validation regex — prevents injection. */
const MODEL_PATTERN = /^[a-zA-Z0-9._/-]+$/;

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
   */
  fastify.post("/api/sessions/:sessionId/swarm/spawn", { bodyLimit: SPAWN_BODY_LIMIT, config: { rateLimit: { max: 10, timeWindow: 60_000 } } }, async (req, reply) => {
    const { prompt, description, permissionMode, model, useWorktree, image } = req.body ?? {};
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });

    // Validate model if provided
    if (model && !MODEL_PATTERN.test(model)) {
      return reply.code(400).send({ error: "Invalid model string" });
    }

    const sessionId = await lookupSessionId(req.params.sessionId);
    const session = await getSession(sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const baseCwd = session.worktree_dir || session.project_dir;
    if (!baseCwd || baseCwd === "unknown") {
      return reply.code(400).send({ error: "Session has no known working directory" });
    }

    if (!isBridgeConnected(baseCwd)) {
      return reply.code(503).send({ error: "No local agent connected for this project" });
    }

    // Enforce concurrency cap
    const allActive = getActiveSwarmAgents();
    if (allActive.length >= MAX_SWARM_AGENTS) {
      return reply.code(429).send({ error: `Maximum concurrent swarm agents (${MAX_SWARM_AGENTS}) reached` });
    }

    const agentId = randomUUID();
    const agentDescription = description || prompt.slice(0, 80);

    // Build bridge payload
    const payload = {
      agentId,
      parentSessionId: sessionId,
      prompt,
      cwd: baseCwd,
      description: agentDescription,
      permissionMode: permissionMode || undefined,
      model: model || undefined,
      useWorktree: !!useWorktree,
    };

    if (image && image.data && image.mimeType) {
      payload.image = { data: image.data, mimeType: image.mimeType };
    }

    // Track agent locally for concurrency cap and listing
    trackSwarmAgent({
      id: agentId,
      description: agentDescription,
      status: "running",
      startedAt: Date.now(),
      sessionId,
    });

    dispatchSwarmToBridge(baseCwd, payload);

    broadcastToSession(sessionId, {
      type: "swarm:spawned",
      agentId,
      parentSessionId: sessionId,
      description: agentDescription,
      startedAt: Date.now(),
      worktree: !!useWorktree,
    });

    return { ok: true, agentId };
  });

  /**
   * Cancel a running swarm agent.
   *
   * @route POST /api/swarm/:agentId/cancel
   */
  fastify.post("/api/swarm/:agentId/cancel", async (req) => {
    const { cancelled } = cancelSwarmAgent(req.params.agentId);
    return { ok: true, cancelled };
  });

  /**
   * Lists active (in-memory) swarm agents for a session.
   *
   * @route GET /api/sessions/:sessionId/swarm
   */
  fastify.get("/api/sessions/:sessionId/swarm", async (req) => {
    const sessionId = await lookupSessionId(req.params.sessionId);
    return getActiveSwarmAgents(sessionId);
  });
}
