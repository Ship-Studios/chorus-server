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

export default async function worktreeDiffRoutes(fastify) {
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
      const range = `${wt.base_branch}...${wt.branch_name}`;
      const diff = await runGit(dir, ["diff", "--no-color", "--unified=5", "--submodule=diff", range]);
      const files = parseDiffToFiles(diff);
      return { worktreeId: wt.id, branchName: wt.branch_name, baseBranch: wt.base_branch, stat: buildStatSummary(files), diff, files };
    } catch (err) {
      return reply.code(500).send({ error: `Git error: ${err.message}` });
    }
  });

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
