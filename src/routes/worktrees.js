import { existsSync } from "node:fs";
import { broadcast } from "../broadcast.js";
import {
  getSession,
  getWorktree,
  getSessionWorktrees,
  getWorktreeByBranch,
  insertWorktree,
  updateWorktreeStatus,
  updateWorktreeConflicts,
  deleteWorktreeRow,
  lookupSessionId,
} from "../db.js";
import { parseDiffToFiles, buildStatSummary, runGit } from "@agent-dashboard/diff-panel/server";
import { deleteBranch, detectConflicts, removeWorktree } from "../prompt.js";

export default async function worktreeRoutes(fastify) {
  // List worktrees. Also scans git worktree list to auto-register any linked
  // worktrees not yet in the DB (e.g. after a DB reset while agents were running).
  fastify.get("/api/sessions/:sessionId/worktrees", async (req) => {
    const sessionId = lookupSessionId(req.params.sessionId);
    const session = getSession.get({ $id: sessionId });

    if (session?.project_dir && existsSync(session.project_dir)) {
      try {
        const out = await runGit(session.project_dir, ["worktree", "list", "--porcelain"]);
        let isFirst = true; // first entry is always the main worktree — skip it
        let currentPath = null;
        let currentBranch = null;
        for (const line of out.split("\n")) {
          if (line.startsWith("worktree ")) {
            currentPath = line.slice(9).trim();
            currentBranch = null;
          } else if (line.startsWith("branch refs/heads/")) {
            currentBranch = line.slice("branch refs/heads/".length).trim();
          } else if (line === "") {
            if (isFirst) {
              isFirst = false;
            } else if (currentBranch) {
              const existing = getWorktreeByBranch.get({ $sessionId: sessionId, $branchName: currentBranch });
              if (!existing) {
                const description = currentBranch.replace(/^agent\//, "").replace(/-[a-f0-9]{6}$/, "").replace(/-/g, " ");
                const { id: wid } = insertWorktree.get({
                  $sessionId: sessionId,
                  $branchName: currentBranch,
                  $baseBranch: "main",
                  $description: description,
                  $agentId: null,
                  $status: "pending",
                });
                const worktreeRow = getWorktree.get({ $id: wid });
                broadcast({ type: "worktree:ready", worktree: worktreeRow, parentSessionId: sessionId });
              }
            }
            currentPath = null;
            currentBranch = null;
          }
        }
      } catch {
        // git unavailable or not a git repo — skip discovery
      }
    }

    return getSessionWorktrees.all({ $sessionId: sessionId });
  });

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
        // Remove the git worktree checkout if one exists for this branch
        try {
          const out = await runGit(dir, ["worktree", "list", "--porcelain"]);
          let currentPath = null;
          let currentBranch = null;
          for (const line of out.split("\n")) {
            if (line.startsWith("worktree ")) {
              currentPath = line.slice(9).trim();
              currentBranch = null;
            } else if (line.startsWith("branch refs/heads/")) {
              currentBranch = line.slice("branch refs/heads/".length).trim();
            } else if (line === "") {
              if (currentBranch === wt.branch_name && currentPath && existsSync(currentPath)) {
                removeWorktree(dir, currentPath);
              }
              currentPath = null;
              currentBranch = null;
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
