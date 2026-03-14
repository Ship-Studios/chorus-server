/**
 * prompt-adapter.js — Auto-selects between CLI subprocess and Agent SDK.
 *
 * When USE_AGENT_SDK=true (or SUPABASE_DB_URL is set for cloud deployment),
 * uses the Agent SDK via prompt-sdk.js. Otherwise falls back to the CLI
 * subprocess approach via prompt.js.
 *
 * This adapter exports the same interface as prompt.js so route files
 * don't need to know which backend is active.
 *
 * @module prompt-adapter
 */

const useAgentSdk = process.env.USE_AGENT_SDK === "true";

let _impl;

if (useAgentSdk) {
  _impl = await import("./prompt-sdk.js");
  console.log("[prompt] Using Agent SDK backend");
} else {
  _impl = await import("./prompt.js");
  console.log("[prompt] Using CLI subprocess backend");
}

export const sendPrompt = _impl.sendPrompt;
export const cancelPrompt = _impl.cancelPrompt;
export const isPromptActive = _impl.isPromptActive;
export const getPromptSessionId = _impl.getPromptSessionId;

// Re-exports from prompt.js (these are the same in both backends)
export const { deleteBranch, getBranchDiffStats, detectConflicts, removeWorktree, getCurrentBranch } = _impl;
export const { spawnSwarmAgent, cancelSwarmAgent, getActiveSwarmAgents, hasActiveSwarmAgents } = _impl;
