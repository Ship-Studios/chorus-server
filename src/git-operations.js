/**
 * git-operations.js — Git worktree operations re-exports.
 *
 * These operations run locally on the server (no bridge relay needed) and
 * provide git worktree management utilities.
 *
 * @module git-operations
 */

export {
  deleteBranch,
  getBranchDiffStats,
  detectConflicts,
  removeWorktree,
  getCurrentBranch,
} from "./prompt-sdk.js";
