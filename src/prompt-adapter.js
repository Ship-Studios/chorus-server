/**
 * prompt-adapter.js — Re-exports Agent SDK prompt and swarm functions.
 *
 * All prompt and swarm operations use the Agent SDK (prompt-sdk.js).
 * This adapter preserves import paths so route files don't need changes.
 *
 * @module prompt-adapter
 */

export {
  sendPrompt,
  cancelPrompt,
  isPromptActive,
  getPromptSessionId,
  deleteBranch,
  getBranchDiffStats,
  detectConflicts,
  removeWorktree,
  getCurrentBranch,
  spawnSwarmAgent,
  cancelSwarmAgent,
  getActiveSwarmAgents,
  hasActiveSwarmAgents,
} from "./prompt-sdk.js";
