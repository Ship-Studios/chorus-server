/**
 * Git diff route — returns the current uncommitted diff for a session.
 *
 * Endpoints:
 *   GET /api/sessions/:id/diff — Uncommitted changes with parsed file hunks
 *
 * Runs `git diff HEAD` in the session's working directory. Falls back to
 * `git diff` (no HEAD) for repos with zero commits. The response includes
 * the raw diff string, a stat summary, the current branch name, and a
 * `files[]` array with parsed hunks compatible with `@git-diff-view/svelte`.
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
import { existsSync } from "node:fs";
import { getSession, lookupSessionId } from "../db.js";
import { parseDiffToFiles, buildStatSummary, runGit } from "@agent-dashboard/diff-panel/server";

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

    // Dedup: if a diff is already running for this directory, reuse the promise
    if (inflightDiffs.has(dir)) {
      const cached = await inflightDiffs.get(dir);
      return { ...cached, sessionId: req.params.sessionId };
    }

    const promise = computeDiff(dir, req.params.sessionId);
    inflightDiffs.set(dir, promise);
    try {
      return await promise;
    } finally {
      inflightDiffs.delete(dir);
    }
  });
}

/**
 * Compute the git diff for a directory.
 *
 * @param {string} dir - The directory to run git diff in.
 * @param {string} sessionId - The session ID.
 * @returns {Promise<object>} The diff results.
 */
async function computeDiff(dir, sessionId) {
  try {
    const diff = await runGit(dir, ["diff", "HEAD", "--no-color", "--unified=5", "--submodule=diff"]);
    const branch = await runGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const files = parseDiffToFiles(diff);

    return {
      sessionId,
      directory: dir,
      branch: branch.trim(),
      stat: buildStatSummary(files),
      diff,
      files,
    };
  } catch {
    // Fallback: repos with no commits yet
    const diff = await runGit(dir, ["diff", "--no-color", "--unified=5", "--submodule=diff"]);
    const files = parseDiffToFiles(diff);
    return {
      sessionId,
      directory: dir,
      branch: "unknown",
      stat: buildStatSummary(files),
      diff,
      files,
    };
  }
}
