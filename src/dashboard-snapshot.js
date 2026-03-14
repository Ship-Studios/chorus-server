import {
  getAllSessions,
  getRecentEventsSlim,
  getRecentAgentsSlim,
  getAllActiveWorktrees,
} from "./db.js";

let snapshotVersion = 0;
let cachedVersion = -1;
let cachedSnapshot = null;
let inflightSnapshot = null;
let inflightVersion = -1;

function buildSnapshot() {
  return {
    sessions: getAllSessions.all(),
    recentEvents: getRecentEventsSlim.all(),
    agents: getRecentAgentsSlim.all(),
    worktrees: getAllActiveWorktrees.all(),
  };
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
  inflightSnapshot = Promise.resolve().then(() => {
    const snapshot = buildSnapshot();
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
