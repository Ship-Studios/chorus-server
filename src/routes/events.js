import { broadcast } from "../broadcast.js";
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
} from "../db.js";

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
