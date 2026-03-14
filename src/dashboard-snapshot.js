import {
  getAllSessions,
  getRecentEventsSlim,
  getRecentAgentsSlim,
  getAllActiveWorktrees,
} from "./db-adapter.js";

let snapshotVersion = 0;
let cachedVersion = -1;
let cachedSnapshot = null;
let inflightSnapshot = null;
let inflightVersion = -1;

async function buildSnapshot() {
  const [sessions, recentEvents, agents, worktrees] = await Promise.all([
    getAllSessions(),
    getRecentEventsSlim(),
    getRecentAgentsSlim(),
    getAllActiveWorktrees(),
  ]);
  return { sessions, recentEvents, agents, worktrees };
}

export function invalidateDashboardSnapshot() {
  snapshotVersion += 1;
  cachedSnapshot = null;
}

export async function getDashboardSnapshot() {
  if (cachedSnapshot && cachedVersion === snapshotVersion) {
    return cachedSnapshot;
  }

  if (inflightSnapshot && inflightVersion === snapshotVersion) {
    return inflightSnapshot;
  }

  const requestVersion = snapshotVersion;
  inflightVersion = requestVersion;
  inflightSnapshot = buildSnapshot().then((snapshot) => {
    if (snapshotVersion === requestVersion) {
      cachedSnapshot = snapshot;
      cachedVersion = requestVersion;
    }
    return snapshot;
  }).finally(() => {
    if (inflightVersion === requestVersion) {
      inflightSnapshot = null;
    }
  });

  return inflightSnapshot;
}
