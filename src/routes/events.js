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
  insertEventRow,
  getEvent,
  getSessionEvents,
  getRecentEventsSlim,
  getSessionAgents,
  updateSessionStatus,
  getSession,
} from "../db-adapter.js";
import { resolveSessionId, lookupSessionId } from "../session-resolver.js";
import { isPromptActive } from "../prompt.js";
import { stopWatching } from "../git-watcher.js";
import { invalidateDashboardSnapshot } from "../dashboard-snapshot.js";
import { syncSessionActivity, clearSessionSyncState } from "../session-sync.js";
import { detectAndInsertAgent } from "../agent-detector.js";
export { clearSessionSyncState } from "../session-sync.js";

const MAX_PAYLOAD_STRING_CHARS = 50_000;
const TRUNCATED_SUFFIX = "…[truncated]";

function truncateString(value) {
  if (typeof value !== "string" || value.length <= MAX_PAYLOAD_STRING_CHARS) {
    return value;
  }
  return value.slice(0, MAX_PAYLOAD_STRING_CHARS) + TRUNCATED_SUFFIX;
}

function stringifyPayload(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, current) => {
    if (typeof current === "string") {
      return truncateString(current);
    }
    if (current && typeof current === "object") {
      if (seen.has(current)) return "[circular]";
      seen.add(current);
    }
    return current;
  });
}

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

    const sessionId = await resolveSessionId(claudeSessionId, body.projectDir || "unknown");

    syncSessionActivity(sessionId, body.projectDir || "unknown");

    const eventId = await insertEventRow({
      sessionId,
      type: body.type ?? "tool_use",
      toolName: body.toolName ?? null,
      filePath: body.filePath ?? null,
      summary: body.summary ?? null,
      payload: body.payload ? stringifyPayload(body.payload) : null,
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
      let changedFiles = [];
      if (body.toolName === "Edit" || body.toolName === "Write") {
        changedFiles = [body.filePath].filter(Boolean);
      } else if (body.toolName === "MultiEdit") {
        changedFiles = (body.payload?.edits ?? []).map((e) => e.file_path).filter(Boolean);
      }
      debouncedDiffInvalidation(sessionId, changedFiles);
    }

    // Auto-detect Agent tool calls and create agent records
    if (body.toolName === "Agent" && body.payload) {
      await detectAndInsertAgent(sessionId, eventId, body.payload.input ?? {}, broadcast);
    }

    invalidateDashboardSnapshot();
    return { ok: true };
  });

  // PreToolUse hook: lightweight signal that a file-modifying tool is about to execute
  // Accepts both camelCase (from bash hook) and snake_case (from HTTP hook)
  fastify.post("/api/events/pre-tool", async (req, reply) => {
    const body = req.body ?? {};
    const rawId = body.sessionId || body.session_id;
    if (!rawId) return reply.code(400).send({ error: "sessionId required" });
    const sessionId = (await lookupSessionId(rawId)) || rawId;
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
    const sessionId = (await lookupSessionId(rawId)) || rawId;
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
    const sessionId = await resolveSessionId(rawId, projectDir);
    const toolName = body.tool_name;
    const toolInput = body.tool_input ?? {};
    const toolResponse = body.tool_response ?? {};

    syncSessionActivity(sessionId, projectDir);

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

    const eventId = await insertEventRow({
      sessionId,
      type: "tool_use",
      toolName: toolName ?? null,
      filePath: toolInput.file_path || toolInput.path || null,
      summary,
      payload: stringifyPayload({ input: toolInput, response: toolResponse }),
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
      let changedFiles = [];
      if (toolName === "Edit" || toolName === "Write") {
        changedFiles = [toolInput.file_path || toolInput.path].filter(Boolean);
      } else if (toolName === "MultiEdit") {
        changedFiles = (toolInput.edits ?? []).map((e) => e.file_path).filter(Boolean);
      }
      debouncedDiffInvalidation(sessionId, changedFiles);
    }

    // Auto-detect Agent tool calls
    if (toolName === "Agent") {
      await detectAndInsertAgent(sessionId, eventId, toolInput, broadcast);
    }

    invalidateDashboardSnapshot();
    return reply.code(200).send();
  });

  // HTTP hook adapter: receives Claude Code's PostToolUseFailure payload
  fastify.post("/api/hooks/post-tool-use-failure", async (req, reply) => {
    const body = req.body ?? {};
    const rawId = body.session_id;
    if (!rawId) return reply.code(200).send();

    const projectDir = body.cwd || "unknown";
    const sessionId = await resolveSessionId(rawId, projectDir);
    const toolName = body.tool_name;
    const toolInput = body.tool_input ?? {};
    const error = body.error || "Tool failed";

    const eventId = await insertEventRow({
      sessionId,
      type: "tool_error",
      toolName: toolName ?? null,
      filePath: toolInput.file_path || toolInput.path || null,
      summary: `${toolName} failed: ${error.slice(0, 120)}`,
      payload: stringifyPayload({ error, input: toolInput }),
    });

    invalidateDashboardSnapshot();
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
    const sessionId = (await lookupSessionId(rawId)) || rawId;
    if (isPromptActive(sessionId)) return reply.code(200).send();
    const session = await getSession(sessionId);
    try {
      await updateSessionStatus(sessionId, "stopped");
    } catch { /* session may not exist */ }
    stopWatching(sessionId, session?.worktree_dir || session?.project_dir);
    clearSessionSyncState(sessionId);
    invalidateDashboardSnapshot();
    if (session) broadcast({ type: "session:updated", session: await getSession(sessionId) });
    return reply.code(200).send();
  });

  fastify.get("/api/sessions/:sessionId/events", async (req) => {
    const sessionId = await lookupSessionId(req.params.sessionId);
    return getSessionEvents(sessionId);
  });

  fastify.get("/api/events/:eventId", async (req, reply) => {
    const event = await getEvent(Number(req.params.eventId));
    if (!event) return reply.code(404).send({ error: "Event not found" });
    return event;
  });

  fastify.get("/api/events", async () => getRecentEventsSlim());

  fastify.get("/api/sessions/:sessionId/agents", async (req) => {
    const sessionId = await lookupSessionId(req.params.sessionId);
    return getSessionAgents(sessionId);
  });
}
