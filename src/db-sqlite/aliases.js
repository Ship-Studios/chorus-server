import * as s from "../db.js";

export async function getAlias(claudeSessionId) {
  return s.getAlias.get({ $claudeSessionId: claudeSessionId }) ?? null;
}

export async function insertAlias(claudeSessionId, dashboardSessionId) {
  return s.insertAlias.run({
    $claudeSessionId: claudeSessionId,
    $dashboardSessionId: dashboardSessionId,
  });
}
