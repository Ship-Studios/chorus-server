import * as s from "../db.js";

export async function insertAgent({ sessionId, eventId, description, agentType, prompt, status }) {
  const row = s.insertAgent.get({
    $sessionId: sessionId,
    $eventId: eventId ?? null,
    $description: description ?? null,
    $agentType: agentType ?? null,
    $prompt: prompt ?? null,
    $status: status ?? "completed",
  });
  return row ?? null;
}

export async function getSessionAgents(sessionId) {
  return s.getSessionAgents.all({ $sessionId: sessionId });
}

export async function getSessionAgentCount(sessionId) {
  return s.getSessionAgentCount.get({ $sessionId: sessionId });
}

export async function getRecentAgents() {
  return s.getRecentAgents.all();
}

export async function getRecentAgentsSlim() {
  return s.getRecentAgentsSlim.all();
}
