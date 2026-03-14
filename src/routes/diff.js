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
 *
 * ETag / 304 support: a SHA-256 of the raw diff string is computed and
 * returned as the `ETag` response header. If the request carries a matching
 * `If-None-Match` header the handler returns 304 without a body, avoiding
 * re-parsing and re-serialising an unchanged diff.
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
import { getSession, lookupSessionId } from "../db.js";
import { parseDiffToFiles, buildStatSummary, runGit } from "@agent-dashboard/diff-panel/server";

const MAX_FILES_DEFAULT = 200;
const MAX_FILES_CAP = 500;

// In-flight dedup: when diff:invalidated fires, all WS clients refetch
// simultaneously. Without dedup, N clients spawn N identical git processes.
// This map coalesces concurrent requests for the same directory into one.
const inflightDiffs = new Map();

/**
 * Fastify plugin for diff routes.
 *
 * @param {import("fastify").FastifyInstance} fastify - The Fastify instance.
 */
export default async function diffRoutes(fastify) {
  fastify.get("/api/sessions/:sessionId/diff", async (req, reply) => {
    const sessionId = lookupSessionId(req.params.sessionId);
    const session = getSession.get({ $id: sessionId });
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const dir = session.worktree_dir || session.project_dir;
    if (!dir || dir === "unknown") {
      return reply.code(400).send({ error: "Session has no known working directory" });
    }

    if (!existsSync(dir)) {
      return reply.code(400).send({ error: `Working directory no longer exists: ${dir}` });
    }

    // Parse maxFiles query param — default 200, hard cap 500
    const rawMax = parseInt(req.query.maxFiles, 10);
    const maxFiles = Number.isFinite(rawMax) && rawMax > 0
      ? Math.min(rawMax, MAX_FILES_CAP)
      : MAX_FILES_DEFAULT;

    // Dedup: if a diff is already running for this directory, reuse the promise
    if (inflightDiffs.has(dir)) {
      const cached = await inflightDiffs.get(dir);
      return applyMaxFiles(
        { ...cached, sessionId: req.params.sessionId },
        maxFiles,
        req,
        reply,
      );
    }

    const promise = computeDiff(dir, req.params.sessionId);
    inflightDiffs.set(dir, promise);
    try {
      const result = await promise;
      return applyMaxFiles(result, maxFiles, req, reply);
    } finally {
      inflightDiffs.delete(dir);
    }
  });
}

/**
 * Apply ETag / 304 logic and maxFiles truncation to a computed diff result,
 * then send the reply.
 *
 * @param {object} result - The raw computed diff (from computeDiff or cache).
 * @param {number} maxFiles - Maximum number of files to include.
 * @param {object} req - Fastify request.
 * @param {object} reply - Fastify reply.
 * @returns {object|undefined} The response object, or undefined if 304 sent.
 */
function applyMaxFiles(result, maxFiles, req, reply) {
  // ETag check — compare against the raw diff hash stored on the result
  const etag = `"${result._diffHash}"`;
  reply.header("ETag", etag);

  const ifNoneMatch = req.headers["if-none-match"];
  if (ifNoneMatch && ifNoneMatch === etag) {
    return reply.code(304).send();
  }

  // Build the public response (no internal _diffHash field)
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
 * Compute the git diff for a directory.
 *
 * @param {string} dir - The directory to run git diff in.
 * @param {string} sessionId - The session ID.
 * @returns {Promise<object>} The diff results (includes internal `_diffHash`).
 */
async function computeDiff(dir, sessionId) {
  try {
    const rawDiff = await runGit(dir, ["diff", "HEAD", "--no-color", "--unified=5", "--submodule=diff"]);
    const branch = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const files = parseDiffToFiles(rawDiff);
    const _diffHash = createHash("sha256").update(rawDiff).digest("hex");

    return {
      sessionId,
      directory: dir,
      branch: branch.trim(),
      stat: buildStatSummary(files),
      files,
      _diffHash,
    };
  } catch {
    // Fallback: repos with no commits yet
    const rawDiff = await runGit(dir, ["diff", "--no-color", "--unified=5", "--submodule=diff"]);
    const files = parseDiffToFiles(rawDiff);
    const _diffHash = createHash("sha256").update(rawDiff).digest("hex");
    return {
      sessionId,
      directory: dir,
      branch: "unknown",
      stat: buildStatSummary(files),
      files,
      _diffHash,
    };
  }
}
