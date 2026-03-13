/**
 * Worktree listing route — list worktrees for a session with auto-discovery
 * of unregistered git worktree branches.
 *
 * Endpoint:
 *   GET /api/sessions/:id/worktrees
 *
 * @module routes/worktrees/list
 */
import { existsSync } from "node:fs";
import {
  getSession,
  getSessionWorktrees,
  getWorktreeByBranch,
  insertWorktree,
  lookupSessionId,
} from "../../db.js";
import { parseWorktreeListPorcelain } from "../../git-worktree.js";
import { runGit } from "@agent-dashboard/diff-panel/server";

/**
 * Fastify plugin for worktree listing routes.
 * 
 * @param {import("fastify").FastifyInstance} fastify - Fastify instance
 */
export default async function worktreeListRoutes(fastify) {
  /**
   * GET /api/sessions/:id/worktrees
   * 
   * List worktrees for a session with auto-discovery of unregistered git worktree branches.
   * 
   * @route GET /api/sessions/:sessionId/worktrees
   * @param {import("fastify").FastifyRequest} req - Fastify request
   */
  fastify.get("/api/sessions/:sessionId/worktrees", async (req) => {
    const sessionId = lookupSessionId(req.params.sessionId);
    const session = getSession.get({ $id: sessionId });

    if (session?.project_dir && existsSync(session.project_dir)) {
      try {
        const out = await runGit(session.project_dir, ["worktree", "list", "--porcelain"]);
        for (const { branch } of parseWorktreeListPorcelain(out)) {
          const existing = getWorktreeByBranch.get({ $sessionId: sessionId, $branchName: branch });
          if (!existing) {
            const description = branch.replace(/^agent\//, "").replace(/-[a-f0-9]{6}$/, "").replace(/-/g, " ");
            insertWorktree.get({
              $sessionId: sessionId,
              $branchName: branch,
              $baseBranch: "main",
              $description: description,
              $agentId: null,
              $status: "pending",
            });
          }
        }
      } catch {
        // git unavailable or not a git repo — skip discovery
      }
    }

    return getSessionWorktrees.all({ $sessionId: sessionId });
  });
}
