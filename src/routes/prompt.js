/**
 * Prompt submission routes — dispatch prompts to the local agent daemon via
 * the Socket.IO bridge and stream responses back to UI clients.
 *
 * Endpoints:
 *   POST /api/sessions/:id/prompt        — Submit a prompt via bridge relay
 *   POST /api/sessions/:id/prompt/cancel — Cancel an active prompt
 *   GET  /api/sessions/:id/prompt/status — Check if a prompt is currently active
 *
 * The submit endpoint dispatches the prompt to the local-agent daemon over the
 * /bridge Socket.IO namespace. The daemon runs the Agent SDK locally and streams
 * chunk/done events back through the bridge, which relays them to UI clients.
 *
 * Each prompt is identified by a client-generated `instanceId` (auto-generated
 * if not provided). Multiple instances can run concurrently for the same session.
 * If no local agent daemon is connected for the session's project, returns 503.
 *
 * Image attachments are passed as base64 in the bridge payload (no temp files).
 *
 * Body limit is 15 MB to accommodate base64-encoded images.
 *
 * @module routes/prompt
 */
import { randomUUID } from "node:crypto";
import { broadcastToSession } from "../broadcast.js";
import { getSession } from "../db-adapter.js";
import { lookupSessionId } from "../session-resolver.js";
import {
  dispatchPromptToBridge,
  isBridgePromptActive,
  isBridgeConnected,
  cancelPrompt,
  trackPromptRequest,
  cancelBridgePrompt,
} from "../prompt-adapter.js";

const PROMPT_BODY_LIMIT = 15 * 1024 * 1024;

/**
 * Fastify plugin for prompt submission and management.
 *
 * @param {import("fastify").FastifyInstance} fastify - Fastify instance
 */
export default async function promptRoutes(fastify) {
  fastify.post("/api/sessions/:sessionId/prompt", { bodyLimit: PROMPT_BODY_LIMIT }, async (req, reply) => {
    const { prompt, permissionMode, image, instanceId: clientInstanceId, description, useWorktree } = req.body ?? {};
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });

    const sessionId = await lookupSessionId(req.params.sessionId);
    const session = await getSession(sessionId);
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const cwd = session.worktree_dir || session.project_dir;
    if (!cwd || cwd === "unknown") {
      return reply.code(400).send({ error: "Session has no known working directory" });
    }

    if (!isBridgeConnected(cwd)) {
      return reply.code(503).send({ error: "No local agent connected for this project" });
    }

    // Each prompt instance gets a unique ID — allows multiple concurrent prompts per session
    const instanceId = clientInstanceId || randomUUID();

    // Build bridge payload — image passed as base64 (no temp file)
    const payload = {
      requestId: instanceId,
      instanceId,
      sessionId,
      prompt,
      cwd,
      permissionMode: permissionMode || undefined,
      model: session.model || undefined,
      claudeSessionId: session.current_claude_session_id || undefined,
      description: description || undefined,
      useWorktree: useWorktree || undefined,
    };

    if (image && image.data && image.mimeType) {
      payload.image = { data: image.data, mimeType: image.mimeType };
    }

    broadcastToSession(sessionId, {
      type: "prompt:start",
      sessionId,
      instanceId,
      prompt,
      hasImage: !!(image && image.data),
      permissionMode: permissionMode || null,
      description: description || null,
      useWorktree: !!useWorktree,
    });

    // Track instanceId -> sessionId for cancel-by-session
    trackPromptRequest(instanceId, sessionId);

    dispatchPromptToBridge(cwd, payload);

    return { ok: true, sessionId, instanceId };
  });

  fastify.post("/api/sessions/:sessionId/prompt/cancel", async (req) => {
    const { instanceId } = req.body ?? {};

    // When instanceId is provided, cancel that specific instance directly
    if (instanceId) {
      const cancelled = cancelBridgePrompt(instanceId);
      return { ok: true, cancelled };
    }

    // Fall back to cancel-by-session (backward compat)
    const sessionId = await lookupSessionId(req.params.sessionId);
    const cancelled = cancelPrompt(sessionId);
    // Do not broadcast prompt:done here — the bridge prompt_done handler
    // is the single source of truth and will emit prompt:done with cancelled: true.
    return { ok: true, cancelled };
  });

  fastify.get("/api/sessions/:sessionId/prompt/status", async (req) => {
    const sessionId = await lookupSessionId(req.params.sessionId);
    return { active: isBridgePromptActive(sessionId) };
  });
}
