import * as s from "../db.js";

export async function insertEvent({ sessionId, type, toolName, filePath, summary, payload }) {
  const row = s.insertEvent.get({
    $sessionId: sessionId,
    $type: type,
    $toolName: toolName ?? null,
    $filePath: filePath ?? null,
    $summary: summary ?? null,
    $payload: payload ?? null,
  });
  return { id: row ? Number(row.id) : null };
}

export async function insertEventRow(params) {
  const { id } = await insertEvent(params);
  return id;
}

export async function getEvent(id) {
  return s.getEvent.get({ $id: id }) ?? null;
}

export async function getSessionEvents(sessionId) {
  return s.getSessionEvents.all({ $sessionId: sessionId });
}

export async function getRecentEvents() {
  return s.getRecentEvents.all();
}

export async function getRecentEventsSlim() {
  return s.getRecentEventsSlim.all();
}

export async function getRecentEventsByUser(userId) {
  return s.getRecentEventsByUser.all({ $userId: userId });
}

export async function getRecentEventsSlimByUser(userId) {
  return s.getRecentEventsSlimByUser.all({ $userId: userId });
}
