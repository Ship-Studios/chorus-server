/**
 * Event and hook routes — log tool use events, handle Claude Code lifecycle hooks,
 * and serve event/agent queries.
 *
 * Endpoints:
 *   POST /api/events                           — Log a tool use event (from bash hooks)
 *   POST /api/events/pre-tool                  — PreToolUse signal (broadcasts diff:pending, no DB write)
 *   POST /api/hooks/pre-tool-use               — HTTP hook adapter for PreToolUse (snake_case payload)
 *   POST /api/hooks/post-tool-use              — HTTP hook adapter for PostToolUse (session heartbeat + event + agent detection)
 *   POST /api/hooks/post-tool-use-failure      — HTTP hook adapter for PostToolUseFailure (logs tool_error events)
 *   POST /api/hooks/stop                       — HTTP hook adapter for Stop (marks session stopped)
 *   GET  /api/sessions/:id/events              — List events for a session (last 200)
 *   GET  /api/events/:id                       — Single event with full payload
 *   GET  /api/events                           — Recent events across all sessions (last 100)
 *   GET  /api/sessions/:id/agents              — List sub-agents for a session
 *
 * Race condition handling: `POST /api/events` auto-creates the session row if it
 * doesn't exist yet, since PostToolUse hooks can fire before the SessionStart hook
 * completes (TOCTOU race between hook scripts).
 *
 * Agent auto-detection: Events with `toolName: "Agent"` trigger automatic insertion
 * into the `agents` table, extracting description, subagent_type, and prompt from
 * the tool input. Prompt text is truncated to 2000 chars in the DB.
 *
 * Diff invalidation: Write-ops (Edit, Write, Bash, MultiEdit) broadcast
 * `diff:invalidated` to trigger UI diff refresh. PostToolUse only fires on success,
 * so no `toolSuccess` check is needed in the HTTP hook adapter path.
 *
 * Payload truncation: Large string values in tool input/response are truncated to
 * ~50KB before storage to keep the SQLite DB lean.
 *
 * @module routes/events
 */
import { broadcast, broadcastToSession, debouncedDiffInvalidation } from "../broadcast.js";
import {
  upsertSession,
  insertEvent,
  getEvent,
  getSessionEvents,
  getRecentEvents,
  insertAgent,
  getSessionAgents,
  resolveSessionId,
  lookupSessionId,
  updateSessionStatus,
  getSession,
} from "../db.js";
import { isPromptActive } from "../prompt.js";

/**
 * Fastify plugin for event and hook routes.
 *
 * @param {import("fastify").FastifyInstance} fastify - The Fastify instance.
 */
export default async function eventRoutes(fastify) {
  // Hook: tool use event (file edit, bash command, etc.)
  fastify.post("/api/events", async (req, reply) => {
    const body = req.body ?? {};
    const claudeSessionId = body.sessionId;

    if (!claudeSessionId) {
      return reply.code(400).send({ error: "sessionId is required" });
    }

    const sessionId = resolveSessionId(claudeSessionId, body.projectDir || "unknown");

    // Auto-create session if it doesn't exist yet (race: PostToolUse before SessionStart)
    upsertSession.run({
      $id: sessionId,
      $projectDir: body.projectDir || "unknown",
      $worktreeDir: null,
      $status: "active",
      $model: null,
      $currentClaudeSessionId: null,
    });

    const { id: eventId } = insertEvent.get({
      $sessionId: sessionId,
      $type: body.type ?? "tool_use",
      $toolName: body.toolName ?? null,
      $filePath: body.filePath ?? null,
      $summary: body.summary ?? null,
      $payload: body.payload ? JSON.stringify(body.payload) : null,
    });
    const event = {
      id: eventId,
      sessionId,
      type: body.type ?? "tool_use",
      toolName: body.toolName,
      filePath: body.filePath,
      summary: body.summary,
      hasPayload: !!body.payload,
      createdAt: new Date().toISOString(),
    };

    broadcast({ type: "event:new", event });

    // Signal diff invalidation for file-modifying tools (only if tool succeeded)
    const isWriteOp = body.toolName === "Edit" || body.toolName === "Write" || body.toolName === "Bash" || body.toolName === "MultiEdit";
    if (isWriteOp && body.toolSuccess !== false) {
      debouncedDiffInvalidation(sessionId);
    }

    // Auto-detect Agent tool calls and create agent records
    if (body.toolName === "Agent" && body.payload) {
      const input = body.payload.input ?? {};
      const description = input.description || input.prompt?.slice(0, 120) || "Sub-agent";
      const agentType = input.subagent_type || "general-purpose";
      const prompt = input.prompt || null;

      const { id: agentId } = insertAgent.get({
        $sessionId: sessionId,
        $eventId: eventId,
        $description: description,
        $agentType: agentType,
        $prompt: prompt ? prompt.slice(0, 2000) : null,
        $status: "completed",
      });

      broadcast({
        type: "agent:new",
        agent: {
          id: agentId,
          sessionId,
          eventId,
          description,
          agentType,
          status: "completed",
          createdAt: new Date().toISOString(),
        },
      });
    }

    return { ok: true };
  });

  // PreToolUse hook: lightweight signal that a file-modifying tool is about to execute
  // Accepts both camelCase (from bash hook) and snake_case (from HTTP hook)
  fastify.post("/api/events/pre-tool", async (req, reply) => {
    const body = req.body ?? {};
    const rawId = body.sessionId || body.session_id;
    if (!rawId) return reply.code(400).send({ error: "sessionId required" });
    const sessionId = lookupSessionId(rawId) || rawId;
    const toolName = body.toolName || body.tool_name;
    broadcastToSession(sessionId, { type: "diff:pending", sessionId, toolName });
    return { ok: true };
  });

  // HTTP hook adapter: receives Claude Code's snake_case PreToolUse payload directly
  fastify.post("/api/hooks/pre-tool-use", async (req, reply) => {
    const body = req.body ?? {};
    const rawId = body.session_id;
    const toolName = body.tool_name;
    if (!rawId) return reply.code(200).send();
    const sessionId = lookupSessionId(rawId) || rawId;
    broadcastToSession(sessionId, { type: "diff:pending", sessionId, toolName });
    return reply.code(200).send();
  });

  // HTTP hook adapter: receives Claude Code's snake_case PostToolUse payload directly
  // Handles session heartbeat + event logging + agent detection in one request
  fastify.post("/api/hooks/post-tool-use", async (req, reply) => {
    const body = req.body ?? {};
    const rawId = body.session_id;
    if (!rawId) return reply.code(200).send();

    const projectDir = body.cwd || "unknown";
    const sessionId = resolveSessionId(rawId, projectDir);
    const toolName = body.tool_name;
    const toolInput = body.tool_input ?? {};
    const toolResponse = body.tool_response ?? {};

    // Session heartbeat
    upsertSession.run({
      $id: sessionId,
      $projectDir: projectDir,
      $worktreeDir: null,
      $status: "active",
      $model: null,
      $currentClaudeSessionId: null,
    });

    // Generate summary (same priority as bash script)
    let summary;
    if (toolInput.command) {
      summary = `${toolName}: ${toolInput.command.slice(0, 120)}`;
    } else if (toolName === "Agent" && toolInput.description) {
      summary = `Agent: ${toolInput.description.slice(0, 120)}`;
    } else if (toolInput.file_path || toolInput.path) {
      summary = `${toolName} on ${toolInput.file_path || toolInput.path}`;
    } else {
      summary = toolName || "unknown";
    }

    // Truncate large string values in payload to ~50KB
    const truncate = (obj) => {
      if (typeof obj === "string") return obj.length > 50000 ? obj.slice(0, 50000) + "…[truncated]" : obj;
      if (Array.isArray(obj)) return obj.map(truncate);
      if (obj && typeof obj === "object") {
        const out = {};
        for (const [k, v] of Object.entries(obj)) out[k] = truncate(v);
        return out;
      }
      return obj;
    };

    const { id: eventId } = insertEvent.get({
      $sessionId: sessionId,
      $type: "tool_use",
      $toolName: toolName ?? null,
      $filePath: toolInput.file_path || toolInput.path || null,
      $summary: summary,
      $payload: JSON.stringify({ input: truncate(toolInput), response: truncate(toolResponse) }),
    });

    const event = {
      id: eventId, sessionId, type: "tool_use", toolName,
      filePath: toolInput.file_path || toolInput.path,
      summary, hasPayload: true, createdAt: new Date().toISOString(),
    };

    broadcast({ type: "event:new", event });

    // Diff invalidation for write-ops (PostToolUse only fires on success)
    const isWriteOp = toolName === "Edit" || toolName === "Write" || toolName === "Bash" || toolName === "MultiEdit";
    if (isWriteOp) {
      debouncedDiffInvalidation(sessionId);
    }

    // Auto-detect Agent tool calls
    if (toolName === "Agent") {
      const description = toolInput.description || toolInput.prompt?.slice(0, 120) || "Sub-agent";
      const agentType = toolInput.subagent_type || "general-purpose";
      const prompt = toolInput.prompt || null;
      const { id: agentId } = insertAgent.get({
        $sessionId: sessionId, $eventId: eventId, $description: description,
        $agentType: agentType, $prompt: prompt ? prompt.slice(0, 2000) : null, $status: "completed",
      });
      broadcast({
        type: "agent:new",
        agent: { id: agentId, sessionId, eventId, description, agentType, status: "completed", createdAt: new Date().toISOString() },
      });
    }

    return reply.code(200).send();
  });

  // HTTP hook adapter: receives Claude Code's PostToolUseFailure payload
  fastify.post("/api/hooks/post-tool-use-failure", async (req, reply) => {
    const body = req.body ?? {};
    const rawId = body.session_id;
    if (!rawId) return reply.code(200).send();

    const projectDir = body.cwd || "unknown";
    const sessionId = resolveSessionId(rawId, projectDir);
    const toolName = body.tool_name;
    const toolInput = body.tool_input ?? {};
    const error = body.error || "Tool failed";

    const { id: eventId } = insertEvent.get({
      $sessionId: sessionId,
      $type: "tool_error",
      $toolName: toolName ?? null,
      $filePath: toolInput.file_path || toolInput.path || null,
      $summary: `${toolName} failed: ${error.slice(0, 120)}`,
      $payload: JSON.stringify({ error, input: toolInput }),
    });

    broadcast({
      type: "event:new",
      event: {
        id: eventId, sessionId, type: "tool_error", toolName,
        filePath: toolInput.file_path || toolInput.path,
        summary: `${toolName} failed: ${error.slice(0, 120)}`,
        hasPayload: true, createdAt: new Date().toISOString(),
      },
    });

    return reply.code(200).send();
  });

  // HTTP hook adapter: receives Claude Code's snake_case Stop payload directly
  fastify.post("/api/hooks/stop", async (req, reply) => {
    const body = req.body ?? {};
    const rawId = body.session_id;
    if (!rawId) return reply.code(200).send();
    const sessionId = lookupSessionId(rawId) || rawId;
    if (isPromptActive(sessionId)) return reply.code(200).send();
    try {
      updateSessionStatus.run({ $id: sessionId, $status: "stopped" });
    } catch { /* session may not exist */ }
    const session = getSession.get({ $id: sessionId });
    if (session) broadcast({ type: "session:updated", session });
    return reply.code(200).send();
  });

  fastify.get("/api/sessions/:sessionId/events", async (req) => {
    const sessionId = lookupSessionId(req.params.sessionId);
    return getSessionEvents.all({ $sessionId: sessionId });
  });

  fastify.get("/api/events/:eventId", async (req, reply) => {
    const event = getEvent.get({ $id: Number(req.params.eventId) });
    if (!event) return reply.code(404).send({ error: "Event not found" });
    return event;
  });

  fastify.get("/api/events", async () => getRecentEvents.all());

  fastify.get("/api/sessions/:sessionId/agents", async (req) => {
    const sessionId = lookupSessionId(req.params.sessionId);
    return getSessionAgents.all({ $sessionId: sessionId });
  });
}
