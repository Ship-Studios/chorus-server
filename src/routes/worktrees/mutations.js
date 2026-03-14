/**
 * Worktree mutation routes — merge, discard, and check conflicts
 * for git worktree branches created by swarm agents.
 *
 * Endpoints:
 *   POST   /api/worktrees/:id/merge           — Merge branch via `git merge --no-ff`, then delete branch
 *   DELETE /api/worktrees/:id                  — Remove worktree checkout, delete branch, remove DB record
 *   POST   /api/worktrees/:id/check-conflicts — Non-destructive conflict detection via `git merge-tree`
 *
 * @module routes/worktrees/mutations
 */
import { existsSync } from "node:fs";
import { broadcastToSession } from "../../broadcast.js";
import {
  getSession,
  getWorktree,
  updateWorktreeStatus,
  updateWorktreeConflicts,
  deleteWorktreeRow,
} from "../../db-adapter.js";
import {
  deleteBranchAsync,
  detectConflictsAsync,
  parseWorktreeListPorcelain,
  removeWorktree,
} from "../../git-worktree.js";
import { runGit } from "@chorus/diff-panel/server";
import { invalidateDiscoveredWorktrees } from "../../worktree-discovery.js";
import { invalidateDashboardSnapshot } from "../../dashboard-snapshot.js";

/**
 * Fastify plugin for worktree mutation routes.
 * 
 * @param {import("fastify").FastifyInstance} fastify - Fastify instance
 */
export default async function worktreeMutationRoutes(fastify) {
  /**
   * POST /api/worktrees/:id/merge
   * 
   * Merge branch via git merge --no-ff, then delete branch.
   * 
   * @route POST /api/worktrees/:worktreeId/merge
   * @param {import("fastify").FastifyRequest} req - Fastify request
   * @param {import("fastify").FastifyReply} reply - Fastify reply
   */
  fastify.post("/api/worktrees/:worktreeId/merge", async (req, reply) => {
    const wt = await getWorktree(Number(req.params.worktreeId));
    if (!wt) return reply.code(404).send({ error: "Worktree not found" });
    if (wt.status === "merged") return reply.code(400).send({ error: "Already merged" });

    const session = await getSession(wt.session_id);
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const dir = session.project_dir;
    if (!dir || !existsSync(dir)) {
      return reply.code(400).send({ error: "Project directory not available" });
    }

    try {
      await runGit(dir, ["merge", "--no-ff", "-m", `Merge ${wt.branch_name}: ${wt.description || "agent changes"}`, wt.branch_name]);
      await deleteBranchAsync(dir, wt.branch_name);
      await updateWorktreeStatus(wt.id, "merged");
      invalidateDiscoveredWorktrees(dir);
      invalidateDashboardSnapshot();
      const updated = await getWorktree(wt.id);
      broadcastToSession(wt.session_id, { type: "worktree:updated", worktree: updated, parentSessionId: wt.session_id });
      return { ok: true, status: "merged" };
    } catch (err) {
      return reply.code(500).send({ error: `Merge failed: ${err.message}` });
    }
  });

  /**
   * DELETE /api/worktrees/:id
   * 
   * Remove worktree checkout, delete branch, remove DB record.
   * 
   * @route DELETE /api/worktrees/:worktreeId
   * @param {import("fastify").FastifyRequest} req - Fastify request
   * @param {import("fastify").FastifyReply} reply - Fastify reply
   */
  fastify.delete("/api/worktrees/:worktreeId", async (req, reply) => {
    const wt = await getWorktree(Number(req.params.worktreeId));
    if (!wt) return reply.code(404).send({ error: "Worktree not found" });

    const session = await getSession(wt.session_id);
    if (session) {
      const dir = session.project_dir;
      if (dir && existsSync(dir)) {
        try {
          const out = await runGit(dir, ["worktree", "list", "--porcelain"]);
          for (const entry of parseWorktreeListPorcelain(out)) {
            if (entry.branch === wt.branch_name && existsSync(entry.path)) {
              await removeWorktree(dir, entry.path);
            }
          }
        } catch {
          // ignore git errors
        }

        if (wt.status !== "merged") {
          await deleteBranchAsync(dir, wt.branch_name);
        }
      }
    }

    await deleteWorktreeRow(wt.id);
    if (session?.project_dir) {
      invalidateDiscoveredWorktrees(session.project_dir);
    }
    invalidateDashboardSnapshot();
    broadcastToSession(wt.session_id, { type: "worktree:removed", worktreeId: wt.id, parentSessionId: wt.session_id });
    return { ok: true };
  });

  /**
   * POST /api/worktrees/:id/check-conflicts
   * 
   * Non-destructive conflict detection via git merge-tree.
   * 
   * @route POST /api/worktrees/:worktreeId/check-conflicts
   * @param {import("fastify").FastifyRequest} req - Fastify request
   * @param {import("fastify").FastifyReply} reply - Fastify reply
   */
  fastify.post("/api/worktrees/:worktreeId/check-conflicts", async (req, reply) => {
    const wt = await getWorktree(Number(req.params.worktreeId));
    if (!wt) return reply.code(404).send({ error: "Worktree not found" });

    const session = await getSession(wt.session_id);
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const dir = session.project_dir;
    if (!dir || !existsSync(dir)) {
      return reply.code(400).send({ error: "Project directory not available" });
    }

    const conflictInfo = await detectConflictsAsync(dir, wt.base_branch, wt.branch_name);
    await updateWorktreeConflicts(wt.id, conflictInfo);
    invalidateDashboardSnapshot();
    const updated = await getWorktree(wt.id);
    broadcastToSession(wt.session_id, { type: "worktree:updated", worktree: updated, parentSessionId: wt.session_id });
    return { ok: true, conflicts: !!conflictInfo, conflictInfo };
  });
}
