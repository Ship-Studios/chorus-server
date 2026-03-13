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
import { broadcast } from "../../broadcast.js";
import {
  getSession,
  getWorktree,
  updateWorktreeStatus,
  updateWorktreeConflicts,
  deleteWorktreeRow,
} from "../../db.js";
import { parseWorktreeListPorcelain } from "../../git-worktree.js";
import { deleteBranch, detectConflicts, removeWorktree } from "../../prompt.js";
import { runGit } from "@agent-dashboard/diff-panel/server";

export default async function worktreeMutationRoutes(fastify) {
  fastify.post("/api/worktrees/:worktreeId/merge", async (req, reply) => {
    const wt = getWorktree.get({ $id: Number(req.params.worktreeId) });
    if (!wt) return reply.code(404).send({ error: "Worktree not found" });
    if (wt.status === "merged") return reply.code(400).send({ error: "Already merged" });

    const session = getSession.get({ $id: wt.session_id });
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const dir = session.project_dir;
    if (!dir || !existsSync(dir)) {
      return reply.code(400).send({ error: "Project directory not available" });
    }

    try {
      await runGit(dir, ["merge", "--no-ff", "-m", `Merge ${wt.branch_name}: ${wt.description || "agent changes"}`, wt.branch_name]);
      deleteBranch(dir, wt.branch_name);
      updateWorktreeStatus.run({ $id: wt.id, $status: "merged" });
      const updated = getWorktree.get({ $id: wt.id });
      broadcast({ type: "worktree:updated", worktree: updated, parentSessionId: wt.session_id });
      return { ok: true, status: "merged" };
    } catch (err) {
      return reply.code(500).send({ error: `Merge failed: ${err.message}` });
    }
  });

  fastify.delete("/api/worktrees/:worktreeId", async (req, reply) => {
    const wt = getWorktree.get({ $id: Number(req.params.worktreeId) });
    if (!wt) return reply.code(404).send({ error: "Worktree not found" });

    const session = getSession.get({ $id: wt.session_id });
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
          deleteBranch(dir, wt.branch_name);
        }
      }
    }

    deleteWorktreeRow.run({ $id: wt.id });
    broadcast({ type: "worktree:removed", worktreeId: wt.id, parentSessionId: wt.session_id });
    return { ok: true };
  });

  fastify.post("/api/worktrees/:worktreeId/check-conflicts", async (req, reply) => {
    const wt = getWorktree.get({ $id: Number(req.params.worktreeId) });
    if (!wt) return reply.code(404).send({ error: "Worktree not found" });

    const session = getSession.get({ $id: wt.session_id });
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const dir = session.project_dir;
    if (!dir || !existsSync(dir)) {
      return reply.code(400).send({ error: "Project directory not available" });
    }

    const conflictInfo = detectConflicts(dir, wt.base_branch, wt.branch_name);
    updateWorktreeConflicts.run({ $id: wt.id, $conflictInfo: conflictInfo });
    const updated = getWorktree.get({ $id: wt.id });
    broadcast({ type: "worktree:updated", worktree: updated, parentSessionId: wt.session_id });
    return { ok: true, conflicts: !!conflictInfo, conflictInfo };
  });
}
