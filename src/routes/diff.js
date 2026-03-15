/**
 * Git diff route — returns the current uncommitted diff for a session.
 *
 * Endpoints:
 *   GET /api/sessions/:id/diff — Uncommitted changes with parsed file hunks
 *
 * Runs `git diff HEAD` in the session's working directory. Falls back to
 * `git diff` (no HEAD) for repos with zero commits. The response includes
 * a stat summary, the current branch name, and a `files[]` array with
 * parsed hunks compatible with `@git-diff-view/svelte`.
 *
 * Query params:
 *   maxFiles — maximum number of files to return (default 200, hard cap 500).
 *              When the parsed file list exceeds this limit the response
 *              includes `truncated: true` and `totalFiles: N`.
 *   files    — comma-separated list of relative file paths to filter the diff.
 *              When present, only the specified files are included in the
 *              response. The global cache is bypassed for filtered requests.
 *              Paths starting with "-" or containing "../" are rejected (400).
 *
 * ETag / 304 support: a SHA-256 of the raw diff string is computed and
 * returned as the `ETag` response header. If the request carries a matching
 * `If-None-Match` header the handler returns 304 without a body, avoiding
 * re-parsing and re-serialising an unchanged diff. ETag/304 is not used for
 * filtered requests.
 *
 * CWD validation: checks `existsSync(dir)` before spawning git to avoid
 * misleading macOS `posix_spawn` ENOENT errors that blame the git binary
 * when the working directory is actually missing.
 *
 * Directory resolution: uses `session.worktree_dir` when set (worktree-linked
 * sessions), otherwise `session.project_dir`. This means the diff reflects the
 * worktree's uncommitted changes when a swarm agent is working in isolation.
 *
 * @module routes/diff
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { getSession } from "../db-adapter.js";
import { lookupSessionId } from "../session-resolver.js";
import { parseDiffToFiles, buildStatSummary, runGit } from "@chorus/diff-panel/server";
import {
  clearInflightDiff,
  getCachedDiff,
  getInflightDiff,
  setCachedDiff,
  setInflightDiff,
} from "../diff-cache.js";
import { executeRemoteTool, isBridgeConnected } from "./bridge.js";

const MAX_FILES_DEFAULT = 200;
const MAX_FILES_CAP = 500;

/**
 * Fastify plugin for diff routes.
 *
 * @param {import("fastify").FastifyInstance} fastify - The Fastify instance.
 */
export function createDiffRoutes(deps = {}) {
  const {
    buildStatSummary: buildStatSummaryImpl = buildStatSummary,
    existsSync: existsSyncImpl = existsSync,
    getSession: getSessionImpl = getSession,
    lookupSessionId: lookupSessionIdImpl = lookupSessionId,
    parseDiffToFiles: parseDiffToFilesImpl = parseDiffToFiles,
    runGit: runGitImpl = runGit,
  } = deps;

  return async function diffRoutes(fastify) {
    fastify.get("/api/sessions/:sessionId/diff", async (req, reply) => {
      const sessionId = await lookupSessionIdImpl(req.params.sessionId);
      const session = await getSessionImpl(sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });

      const dir = session.worktree_dir || session.project_dir;
      if (!dir || dir === "unknown") {
        return reply.code(400).send({ error: "Session has no known working directory" });
      }

      // Parse maxFiles query param — default 200, hard cap 500
      const rawMax = parseInt(req.query.maxFiles, 10);
      const maxFiles = Number.isFinite(rawMax) && rawMax > 0
        ? Math.min(rawMax, MAX_FILES_CAP)
        : MAX_FILES_DEFAULT;

      // Directory doesn't exist locally (e.g. server deployed on Railway) —
      // try routing through the bridge to the user's local agent.
      if (!existsSyncImpl(dir)) {
        if (!isBridgeConnected(dir)) {
          return reply.code(400).send({ error: `Working directory no longer exists: ${dir}` });
        }
        return computeBridgeDiff(dir, req.params.sessionId, maxFiles, req, reply, {
          buildStatSummary: buildStatSummaryImpl,
          parseDiffToFiles: parseDiffToFilesImpl,
        });
      }

      // Parse optional file filter — bypasses cache entirely when present
      const filesParam = req.query.files;
      const fileFilter = filesParam
        ? filesParam.split(",").map((f) => f.trim()).filter(Boolean)
        : null;

      if (fileFilter !== null) {
        // Security: reject any path starting with "-" (flag injection) or containing "../"
        const badPath = fileFilter.find((f) => f.startsWith("-") || f.includes("../"));
        if (badPath) {
          return reply.code(400).send({ error: `Invalid file path in filter: ${badPath}` });
        }
        return computeFilteredDiff(dir, fileFilter, req.params.sessionId, maxFiles, reply, {
          buildStatSummary: buildStatSummaryImpl,
          parseDiffToFiles: parseDiffToFilesImpl,
          runGit: runGitImpl,
        });
      }

      const cached = getCachedDiff(dir);
      if (cached) {
        return sendDiffResult(
          dir,
          cached,
          req.params.sessionId,
          maxFiles,
          req,
          reply,
          {
            buildStatSummary: buildStatSummaryImpl,
            parseDiffToFiles: parseDiffToFilesImpl,
            runGit: runGitImpl,
          },
        );
      }

      const inflight = getInflightDiff(dir);
      if (inflight) {
        const result = await inflight;
        return sendDiffResult(
          dir,
          result,
          req.params.sessionId,
          maxFiles,
          req,
          reply,
          {
            buildStatSummary: buildStatSummaryImpl,
            parseDiffToFiles: parseDiffToFilesImpl,
            runGit: runGitImpl,
          },
        );
      }

      const promise = computeDiffBase(dir, { runGit: runGitImpl });
      setInflightDiff(dir, promise);
      try {
        const result = await promise;
        setCachedDiff(dir, result);
        return sendDiffResult(
          dir,
          result,
          req.params.sessionId,
          maxFiles,
          req,
          reply,
          {
            buildStatSummary: buildStatSummaryImpl,
            parseDiffToFiles: parseDiffToFilesImpl,
            runGit: runGitImpl,
          },
        );
      } finally {
        clearInflightDiff(dir);
      }
    });
  };
}

export default createDiffRoutes();

/**
 * Returns a diff response, only materializing file hunks when the body is needed.
 *
 * @param {string} dir - Diff cache key / working directory.
 * @param {object} result - Cached or in-flight diff state.
 * @param {string} sessionId - Session ID to include in the response body.
 * @param {number} maxFiles - Maximum number of files to include.
 * @param {object} req - Fastify request.
 * @param {object} reply - Fastify reply.
 * @param {object} deps - Dependency bag.
 * @returns {object|undefined} The response object, or undefined if 304 sent.
 */
async function sendDiffResult(dir, result, sessionId, maxFiles, req, reply, deps) {
  const etag = `"${result._diffHash}"`;
  reply.header("ETag", etag);

  if (req.headers["if-none-match"] === etag) {
    return reply.code(304).send();
  }

  const materialized = await materializeDiffResult(dir, result, deps);
  return applyMaxFiles({ ...materialized, sessionId }, maxFiles);
}

/**
 * Applies maxFiles truncation to an already-materialized diff result.
 *
 * @param {object} result - Materialized diff result.
 * @param {number} maxFiles - Maximum number of files to include.
 * @returns {object} Public diff payload.
 */
function applyMaxFiles(result, maxFiles) {
  const { _diffHash, files: allFiles, ...rest } = result;

  if (allFiles.length > maxFiles) {
    return {
      ...rest,
      files: allFiles.slice(0, maxFiles),
      truncated: true,
      totalFiles: allFiles.length,
    };
  }

  return { ...rest, files: allFiles };
}

/**
 * Materializes a cached raw diff into parsed file hunks and stat summary.
 *
 * @param {string} dir - The directory to run git diff in.
 * @param {object} result - Cached or in-flight diff state.
 * @param {object} deps - Dependency bag.
 * @returns {Promise<object>} Materialized diff result.
 */
async function materializeDiffResult(dir, result, deps) {
  const {
    buildStatSummary: buildStatSummaryImpl,
    parseDiffToFiles: parseDiffToFilesImpl,
    runGit: runGitImpl,
  } = deps;

  if (Array.isArray(result.files)) {
    return result;
  }

  if (result.materializePromise) {
    return result.materializePromise;
  }

  result.materializePromise = (async () => {
    const [files, branch] = await Promise.all([
      Promise.resolve(parseDiffToFilesImpl(result.rawDiff)),
      // Use pre-fetched branch (from bridge) when available; otherwise run git locally
      result.branch
        ? Promise.resolve(result.branch)
        : result.hasHead && runGitImpl
          ? runGitImpl(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).then((value) => value.trim()).catch(() => "unknown")
          : Promise.resolve("unknown"),
    ]);
    const materialized = {
      directory: dir,
      branch,
      stat: buildStatSummaryImpl(files),
      files,
      _diffHash: result._diffHash,
    };
    setCachedDiff(dir, materialized);
    return materialized;
  })().finally(() => {
    delete result.materializePromise;
  });

  return result.materializePromise;
}

/**
 * Compute the raw git diff and hash for a directory.
 *
 * @param {string} dir - The directory to run git diff in.
 * @param {object} deps - Dependency bag.
 * @returns {Promise<object>} Raw diff state (includes internal `_diffHash`).
 */
async function computeDiffBase(dir, deps) {
  const { runGit: runGitImpl } = deps;

  try {
    const rawDiff = await runGitImpl(dir, ["diff", "HEAD", "--no-color", "--unified=5", "--submodule=diff"]);
    return {
      directory: dir,
      hasHead: true,
      rawDiff,
      _diffHash: createHash("sha256").update(rawDiff).digest("hex"),
    };
  } catch {
    const rawDiff = await runGitImpl(dir, ["diff", "--no-color", "--unified=5", "--submodule=diff"]);
    return {
      directory: dir,
      hasHead: false,
      rawDiff,
      _diffHash: createHash("sha256").update(rawDiff).digest("hex"),
    };
  }
}

/**
 * Compute and return a filtered diff for specific file paths, bypassing the
 * global cache entirely. ETag/304 support is intentionally omitted.
 *
 * @param {string} dir - The working directory.
 * @param {string[]} fileFilter - Relative file paths to include.
 * @param {string} sessionId - Session ID to include in the response body.
 * @param {number} maxFiles - Maximum number of files to include.
 * @param {object} reply - Fastify reply.
 * @param {object} deps - Dependency bag.
 * @returns {Promise<object>} The diff response object.
 */
/**
 * Compute a diff by routing through the local agent bridge.
 * Used when the working directory doesn't exist on the server (remote deployment).
 */
async function computeBridgeDiff(dir, sessionId, maxFiles, req, reply, deps) {
  const { buildStatSummary: buildStatSummaryImpl, parseDiffToFiles: parseDiffToFilesImpl } = deps;

  const cached = getCachedDiff(dir);
  if (cached) {
    return sendDiffResult(dir, cached, sessionId, maxFiles, req, reply, {
      buildStatSummary: buildStatSummaryImpl,
      parseDiffToFiles: parseDiffToFilesImpl,
    });
  }

  const inflight = getInflightDiff(dir);
  if (inflight) {
    const result = await inflight;
    return sendDiffResult(dir, result, sessionId, maxFiles, req, reply, {
      buildStatSummary: buildStatSummaryImpl,
      parseDiffToFiles: parseDiffToFilesImpl,
    });
  }

  const promise = (async () => {
    const bridgeResult = await executeRemoteTool(dir, "git_diff", {
      cwd: dir,
      raw: true,
    });
    const rawDiff = bridgeResult.rawDiff ?? "";
    return {
      directory: dir,
      branch: bridgeResult.branch ?? "unknown",
      hasHead: bridgeResult.hasHead ?? true,
      rawDiff,
      _diffHash: createHash("sha256").update(rawDiff).digest("hex"),
    };
  })();

  setInflightDiff(dir, promise);
  try {
    const result = await promise;
    setCachedDiff(dir, result);
    return sendDiffResult(dir, result, sessionId, maxFiles, req, reply, {
      buildStatSummary: buildStatSummaryImpl,
      parseDiffToFiles: parseDiffToFilesImpl,
    });
  } finally {
    clearInflightDiff(dir);
  }
}

async function computeFilteredDiff(dir, fileFilter, sessionId, maxFiles, reply, deps) {
  const {
    buildStatSummary: buildStatSummaryImpl,
    parseDiffToFiles: parseDiffToFilesImpl,
    runGit: runGitImpl,
  } = deps;

  let rawDiff;
  let hasHead = true;

  try {
    rawDiff = await runGitImpl(dir, [
      "diff", "HEAD", "--no-color", "--unified=5", "--submodule=diff", "--",
      ...fileFilter,
    ]);
  } catch {
    hasHead = false;
    rawDiff = await runGitImpl(dir, [
      "diff", "--no-color", "--unified=5", "--submodule=diff", "--",
      ...fileFilter,
    ]);
  }

  const [files, branch] = await Promise.all([
    Promise.resolve(parseDiffToFilesImpl(rawDiff)),
    hasHead
      ? runGitImpl(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).then((v) => v.trim()).catch(() => "unknown")
      : Promise.resolve("unknown"),
  ]);
  const stat = buildStatSummaryImpl(files);

  return applyMaxFiles({ sessionId, directory: dir, branch, stat, files }, maxFiles);
}
