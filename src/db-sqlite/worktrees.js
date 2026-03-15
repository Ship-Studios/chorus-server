import * as s from "../db.js";

export async function getWorktree(id) {
  return s.getWorktree.get({ $id: id }) ?? null;
}

export async function getWorktreeByBranch(sessionId, branchName) {
  return s.getWorktreeByBranch.get({ $sessionId: sessionId, $branchName: branchName }) ?? null;
}

export async function getSessionWorktrees(sessionId) {
  return s.getSessionWorktrees.all({ $sessionId: sessionId });
}

export async function getAllActiveWorktrees() {
  return s.getAllActiveWorktrees.all();
}

export async function insertWorktree({ sessionId, branchName, baseBranch, description, agentId, status }) {
  const row = s.insertWorktree.get({
    $sessionId: sessionId,
    $branchName: branchName,
    $baseBranch: baseBranch ?? "main",
    $description: description ?? null,
    $agentId: agentId ?? null,
    $status: status ?? "pending",
  });
  return row ?? null;
}

export async function updateWorktreeStats(id, { filesChanged, insertions, deletions, diffStat, status }) {
  return s.updateWorktreeStats.run({
    $id: id,
    $filesChanged: filesChanged ?? 0,
    $insertions: insertions ?? 0,
    $deletions: deletions ?? 0,
    $diffStat: diffStat ?? null,
    $status: status,
  });
}

export async function updateWorktreeStatus(id, status) {
  return s.updateWorktreeStatus.run({ $id: id, $status: status });
}

export async function updateWorktreeConflicts(id, conflictInfo) {
  return s.updateWorktreeConflicts.run({ $id: id, $conflictInfo: conflictInfo ?? null });
}

export async function deleteWorktreeRow(id) {
  return s.deleteWorktreeRow.run({ $id: id });
}
