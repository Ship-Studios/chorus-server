/**
 * Worktree review routes — list, diff, merge, discard, and check conflicts
 * for git worktree branches created by swarm agents.
 *
 * Composed from:
 *   list.js      — GET /api/sessions/:id/worktrees (auto-discovers unregistered branches)
 *   diff.js      — GET /api/worktrees/:id/diff, GET /api/worktrees/:id/files
 *   mutations.js — POST merge, DELETE, POST check-conflicts
 *
 * @module routes/worktrees
 */
import worktreeListRoutes from "./list.js";
import worktreeDiffRoutes from "./diff.js";
import worktreeMutationRoutes from "./mutations.js";

/**
 * Fastify plugin for worktree routes.
 * 
 * @param {import("fastify").FastifyInstance} fastify - Fastify instance
 */
export default async function worktreeRoutes(fastify) {
  await fastify.register(worktreeListRoutes);
  await fastify.register(worktreeDiffRoutes);
  await fastify.register(worktreeMutationRoutes);
}
