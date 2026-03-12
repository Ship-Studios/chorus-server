import { broadcast } from "../broadcast.js";
import {
  getSession,
  lookupSessionId,
  insertWorktree,
  updateWorktreeStats,
  updateWorktreeConflicts,
  getWorktree,
} from "../db.js";
import { spawnSwarmAgent, cancelSwarmAgent, getActiveSwarmAgents } from "../prompt.js";

export default async function swarmRoutes(fastify) {
  fastify.post("/api/sessions/:sessionId/swarm/spawn", async (req, reply) => {
    const { prompt, description, permissionMode, maxTurns, model, useWorktree } = req.body ?? {};
    if (!prompt) return reply.code(400).send({ error: "prompt is required" });

    const sessionId = lookupSessionId(req.params.sessionId);
    const session = getSession.get({ $id: sessionId });
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const baseCwd = session.worktree_dir || session.project_dir;
    if (!baseCwd || baseCwd === "unknown") {
      return reply.code(400).send({ error: "Session has no known working directory" });
    }

    const agentDescription = description || prompt.slice(0, 80);

    let agentId;
    try {
      ({ id: agentId } = await spawnSwarmAgent(
        { prompt, cwd: baseCwd, description: agentDescription, permissionMode, maxTurns, model, parentSessionId: sessionId, useWorktree: !!useWorktree },
        (event) => {
          // When a worktree agent finishes, persist the record to DB
          if (event.type === "swarm:done" && event.worktree) {
            const wt = event.worktree;
            const status = wt.filesChanged > 0 ? "ready" : "empty";

            const { id: worktreeDbId } = insertWorktree.get({
              $sessionId: sessionId,
              $branchName: wt.branchName,
              $baseBranch: wt.baseBranch,
              $description: agentDescription,
              $agentId: event.agentId,
              $status: status,
            });

            updateWorktreeStats.run({
              $id: worktreeDbId,
              $filesChanged: wt.filesChanged,
              $insertions: wt.insertions,
              $deletions: wt.deletions,
              $diffStat: wt.diffStat,
              $status: status,
            });

            if (wt.conflictInfo) {
              updateWorktreeConflicts.run({ $id: worktreeDbId, $conflictInfo: wt.conflictInfo });
            }

            const worktreeRow = getWorktree.get({ $id: worktreeDbId });
            broadcast({ type: "worktree:ready", worktree: worktreeRow, parentSessionId: sessionId });

            // Strip redundant worktree stats from swarm:done — the worktree:ready message
            // already carries the full record; clients don't need the raw stats twice.
            const { worktree: _discard, ...eventWithoutWorktree } = event;
            broadcast({ ...eventWithoutWorktree, parentSessionId: sessionId });
            return; // Don't fall through to the generic broadcast
          }

          broadcast({ ...event, parentSessionId: sessionId });
        },
      ));
    } catch (err) {
      if (err.message.startsWith("Maximum concurrent swarm agents")) {
        return reply.code(429).send({ error: err.message });
      }
      throw err;
    }

    broadcast({ type: "swarm:spawned", agentId, parentSessionId: sessionId, description: agentDescription, startedAt: Date.now(), worktree: !!useWorktree });
    return { ok: true, agentId };
  });

  fastify.post("/api/swarm/:agentId/cancel", async (req) => {
    const { cancelled, sessionId: parentSessionId } = cancelSwarmAgent(req.params.agentId);
    if (cancelled) {
      broadcast({ type: "swarm:done", agentId: req.params.agentId, parentSessionId, exitCode: null, cancelled: true });
    }
    return { ok: true, cancelled };
  });

  fastify.get("/api/sessions/:sessionId/swarm", async (req) => {
    const sessionId = lookupSessionId(req.params.sessionId);
    return getActiveSwarmAgents(sessionId);
  });
}
