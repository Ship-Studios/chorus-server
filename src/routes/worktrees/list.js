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
  insertWorktree,
  lookupSessionId,
} from "../../db.js";
import { getDiscoveredWorktrees } from "../../worktree-discovery.js";
import { invalidateDashboardSnapshot } from "../../dashboard-snapshot.js";

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
    let worktrees = getSessionWorktrees.all({ $sessionId: sessionId });

    if (session?.project_dir && existsSync(session.project_dir)) {
      try {
        const discovered = await getDiscoveredWorktrees(session.project_dir);
        const knownBranches = new Set(worktrees.map((worktree) => worktree.branch_name));
        let inserted = false;
        for (const { branch } of discovered) {
          if (!knownBranches.has(branch)) {
            const description = branch.replace(/^agent\//, "").replace(/-[a-f0-9]{6}$/, "").replace(/-/g, " ");
            insertWorktree.get({
              $sessionId: sessionId,
              $branchName: branch,
              $baseBranch: "main",
              $description: description,
              $agentId: null,
              $status: "pending",
            });
            knownBranches.add(branch);
            inserted = true;
          }
        }
        if (inserted) {
          invalidateDashboardSnapshot();
          worktrees = getSessionWorktrees.all({ $sessionId: sessionId });
        }
      } catch {
        // git unavailable or not a git repo — skip discovery
      }
    }

    return worktrees;
  });
}
