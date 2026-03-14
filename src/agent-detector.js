import { insertAgent } from "./db.js";

export function detectAndInsertAgent(sessionId, eventId, toolInput, broadcast) {
  if (!toolInput) return null;

  const description = toolInput.description || toolInput.prompt?.slice(0, 120) || "Sub-agent";
  const agentType = toolInput.subagent_type || "general-purpose";
  const prompt = toolInput.prompt || null;

  const { id: agentId } = insertAgent.get({
    $sessionId: sessionId,
    $eventId: eventId,
    $description: description,
    $agentType: agentType,
    $prompt: prompt ? prompt.slice(0, 2000) : null,
    $status: "completed",
  });

  const agent = {
    id: agentId,
    sessionId,
    eventId,
    description,
    agentType,
    status: "completed",
    createdAt: new Date().toISOString(),
  };

  if (broadcast) {
    broadcast({ type: "agent:new", agent });
  }

  return agent;
}
