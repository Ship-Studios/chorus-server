import { touchSessionActive, upsertSession } from "./db.js";

const SESSION_SYNC_INTERVAL_MS = 5_000;
const sessionSyncState = new Map();

export function clearSessionSyncState(sessionId) {
  sessionSyncState.delete(sessionId);
}

export function syncSessionActivity(sessionId, projectDir) {
  const now = Date.now();
  const normalizedProjectDir = projectDir || "unknown";
  const previous = sessionSyncState.get(sessionId);
  const shouldFullSync =
    !previous ||
    (normalizedProjectDir !== "unknown" && previous.projectDir !== normalizedProjectDir);
  const shouldPersistActivity =
    shouldFullSync ||
    !previous ||
    now - previous.lastPersistedAt >= SESSION_SYNC_INTERVAL_MS;

  if (!shouldPersistActivity) {
    return;
  }

  if (shouldFullSync) {
    upsertSession.run({
      $id: sessionId,
      $projectDir: normalizedProjectDir,
      $worktreeDir: null,
      $gitRoot: null,
      $status: "active",
      $model: null,
      $currentClaudeSessionId: null,
    });
    sessionSyncState.set(sessionId, {
      lastPersistedAt: now,
      projectDir: normalizedProjectDir !== "unknown" ? normalizedProjectDir : previous?.projectDir ?? "unknown",
    });
    return;
  }

  const result = touchSessionActive.run({ $id: sessionId });
  if (result.changes === 0) {
    upsertSession.run({
      $id: sessionId,
      $projectDir: normalizedProjectDir,
      $worktreeDir: null,
      $gitRoot: null,
      $status: "active",
      $model: null,
      $currentClaudeSessionId: null,
    });
    sessionSyncState.set(sessionId, {
      lastPersistedAt: now,
      projectDir: normalizedProjectDir !== "unknown" ? normalizedProjectDir : previous?.projectDir ?? "unknown",
    });
    return;
  }

  sessionSyncState.set(sessionId, {
    lastPersistedAt: now,
    projectDir: previous?.projectDir ?? normalizedProjectDir,
  });
}
