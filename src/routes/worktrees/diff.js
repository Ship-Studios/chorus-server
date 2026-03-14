/**
 * Worktree diff routes — read-only git queries for branch diffs and file lists.
 *
 * Endpoints:
 *   GET /api/worktrees/:id/diff   — Three-dot diff of branch against base
 *   GET /api/worktrees/:id/files  — Changed file list (`git diff --name-status`)
 *
 * @module routes/worktrees/diff
 */
import { existsSync } from "node:fs";
import { getSession, getWorktree } from "../../db.js";
import { parseDiffToFiles, buildStatSummary, runGit } from "@agent-dashboard/diff-panel/server";

/**
 * Fastify plugin for worktree diff routes.
 * 
 * @param {import("fastify").FastifyInstance} fastify - Fastify instance
 */
export default async function worktreeDiffRoutes(fastify) {
  async function listChangedPaths(dir, range) {
    const output = await runGit(dir, ["diff", "--name-only", range]);
    return output.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  }

  /**
   * GET /api/worktrees/:id/diff
   * 
   * Three-dot diff of branch against base.
   * 
   * @route GET /api/worktrees/:worktreeId/diff
   * @param {import("fastify").FastifyRequest} req - Fastify request
   * @param {import("fastify").FastifyReply} reply - Fastify reply
   */
  fastify.get("/api/worktrees/:worktreeId/diff", async (req, reply) => {
    const wt = getWorktree.get({ $id: Number(req.params.worktreeId) });
    if (!wt) return reply.code(404).send({ error: "Worktree not found" });

    const session = getSession.get({ $id: wt.session_id });
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const dir = session.project_dir;
    if (!dir || !existsSync(dir)) {
      return reply.code(400).send({ error: "Project directory not available" });
    }

    try {
      const MAX_FILES_DEFAULT = 200;
      const maxFiles = Math.min(Number(req.query.maxFiles) || MAX_FILES_DEFAULT, 500);
      const range = `${wt.base_branch}...${wt.branch_name}`;
      let totalFiles = wt.files_changed || 0;
      let diffArgs = ["diff", "--no-color", "--unified=5", "--submodule=diff", range];

      if (totalFiles > maxFiles) {
        const changedPaths = await listChangedPaths(dir, range);
        totalFiles = changedPaths.length || totalFiles;
        if (changedPaths.length > maxFiles) {
          diffArgs = [...diffArgs, "--", ...changedPaths.slice(0, maxFiles)];
        }
      }

      const diff = await runGit(dir, diffArgs);
      const files = parseDiffToFiles(diff);
      const truncated = totalFiles > maxFiles;
      return {
        worktreeId: wt.id,
        branchName: wt.branch_name,
        baseBranch: wt.base_branch,
        stat: wt.diff_stat || buildStatSummary(files),
        diff: "",
        files,
        totalFiles: totalFiles || files.length,
        truncated,
      };
    } catch (err) {
      return reply.code(500).send({ error: `Git error: ${err.message}` });
    }
  });

  /**
   * GET /api/worktrees/:id/files
   * 
   * Changed file list (git diff --name-status).
   * 
   * @route GET /api/worktrees/:worktreeId/files
   * @param {import("fastify").FastifyRequest} req - Fastify request
   * @param {import("fastify").FastifyReply} reply - Fastify reply
   */
  fastify.get("/api/worktrees/:worktreeId/files", async (req, reply) => {
    const wt = getWorktree.get({ $id: Number(req.params.worktreeId) });
    if (!wt) return reply.code(404).send({ error: "Worktree not found" });

    const session = getSession.get({ $id: wt.session_id });
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const dir = session.project_dir;
    if (!dir || !existsSync(dir)) {
      return reply.code(400).send({ error: "Project directory not available" });
    }

    try {
      const namestat = await runGit(dir, ["diff", "--name-status", `${wt.base_branch}...${wt.branch_name}`]);
      const files = namestat.trim().split("\n").filter(Boolean).map((line) => {
        const [status, ...rest] = line.split("\t");
        return { status, file: rest.join("\t") };
      });
      return { worktreeId: wt.id, files };
    } catch (err) {
      return reply.code(500).send({ error: `Git error: ${err.message}` });
    }
  });
}
