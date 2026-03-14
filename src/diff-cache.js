const CACHE_TTL_MS = 15_000;
const MAX_CACHE_ENTRIES = 50;

const cachedDiffs = new Map();
const inflightDiffs = new Map();

export function getCachedDiff(dir) {
  const entry = cachedDiffs.get(dir);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cachedDiffs.delete(dir);
    return null;
  }

  cachedDiffs.delete(dir);
  cachedDiffs.set(dir, entry);
  return entry.result;
}

export function setCachedDiff(dir, result) {
  cachedDiffs.delete(dir);
  cachedDiffs.set(dir, { result, timestamp: Date.now() });

  if (cachedDiffs.size > MAX_CACHE_ENTRIES) {
    const oldest = cachedDiffs.keys().next().value;
    cachedDiffs.delete(oldest);
  }
}

export function getInflightDiff(dir) {
  return inflightDiffs.get(dir) ?? null;
}

export function setInflightDiff(dir, promise) {
  inflightDiffs.set(dir, promise);
}

export function clearInflightDiff(dir) {
  inflightDiffs.delete(dir);
}

export function invalidateDiffCache(dir) {
  if (dir) {
    cachedDiffs.delete(dir);
    inflightDiffs.delete(dir);
    return;
  }

  cachedDiffs.clear();
  inflightDiffs.clear();
}
