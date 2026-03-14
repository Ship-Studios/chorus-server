/**
 * @file architecture.js
 * @module architecture
 *
 * Public entry points for scanning a project's source architecture.
 * Orchestrates filesystem walking, tree building, and flow resolution,
 * delegating the heavy lifting to focused submodules.
 */

import { buildDirectoryTree } from "./architecture-tree.js";
import { resolveFlows } from "./architecture-flows.js";
import { walkProjectFiles } from "./architecture-walker.js";

const cache = new Map();
const inflight = new Map();
const CACHE_TTL = 30_000;
const CACHE_MAX_SIZE = 100;

export async function scanArchitecture(projectDir) {
  const { files, fileImports } = await walkProjectFiles(projectDir);
  const tree = buildDirectoryTree(projectDir, files);
  const flows = resolveFlows(files, fileImports, projectDir);
  return { tree, flows };
}

export async function getArchitecture(projectDir) {
  const now = Date.now();
  const cached = cache.get(projectDir);
  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.result;
  }

  if (inflight.has(projectDir)) {
    return inflight.get(projectDir);
  }

  const promise = scanArchitecture(projectDir)
    .then((result) => {
      cache.set(projectDir, { result, timestamp: Date.now() });
      if (cache.size > CACHE_MAX_SIZE) {
        cache.delete(cache.keys().next().value);
      }
      return result;
    })
    .finally(() => {
      inflight.delete(projectDir);
    });

  inflight.set(projectDir, promise);
  return promise;
}
