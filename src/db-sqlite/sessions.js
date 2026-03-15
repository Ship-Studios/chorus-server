import * as s from "../db.js";

export async function upsertSession({ id, projectDir, worktreeDir, gitRoot, status, model, currentClaudeSessionId, userId }) {
  return s.upsertSession.run({
    $id: id,
    $projectDir: projectDir,
    $worktreeDir: worktreeDir ?? null,
    $gitRoot: gitRoot ?? null,
    $status: status,
    $model: model ?? null,
    $currentClaudeSessionId: currentClaudeSessionId ?? null,
    $userId: userId ?? null,
  });
}

export async function updateSessionGitRoot(id, gitRoot) {
  return s.updateSessionGitRoot.run({ $id: id, $gitRoot: gitRoot ?? null });
}

export async function updateSessionStatus(id, status) {
  return s.updateSessionStatus.run({ $id: id, $status: status });
}

export async function touchSessionActive(id) {
  return s.touchSessionActive.run({ $id: id });
}

export async function updateSessionClaudeId(id, claudeSessionId) {
  return s.updateSessionClaudeId.run({ $id: id, $claudeSessionId: claudeSessionId });
}

export async function getSession(id) {
  return s.getSession.get({ $id: id }) ?? null;
}

export async function getActiveSessions() {
  return s.getActiveSessions.all();
}

export async function getAllSessions() {
  return s.getAllSessions.all();
}

export async function findActiveSessionByDir(projectDir) {
  return s.findActiveSessionByDir.get({ $projectDir: projectDir }) ?? null;
}

export async function findRecentSessionByDir(projectDir) {
  return s.findRecentSessionByDir.get({ $projectDir: projectDir }) ?? null;
}

export async function findActiveSessionByGitRoot(gitRoot) {
  return s.findActiveSessionByGitRoot.get({ $gitRoot: gitRoot }) ?? null;
}

export async function findRecentSessionByGitRoot(gitRoot) {
  return s.findRecentSessionByGitRoot.get({ $gitRoot: gitRoot }) ?? null;
}

export async function getAllSessionsByUser(userId) {
  return s.getAllSessionsByUser.all({ $userId: userId });
}

export async function deleteSession(sessionId) {
  return s.deleteSession(sessionId);
}
