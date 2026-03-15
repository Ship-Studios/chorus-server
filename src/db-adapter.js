/**
 * db-adapter.js — Database backend selector.
 *
 * Auto-selects between Supabase/PostgreSQL (production) and SQLite (local dev)
 * based on whether the SUPABASE_DB_URL environment variable is set.
 *
 * All route files and core modules should import from this file so they are
 * backend-agnostic.
 *
 * SQLite implementation is split by domain under ./db-sqlite/:
 *   sessions.js · events.js · aliases.js · agents.js · worktrees.js
 *   craft-agents.js · craft-recipes.js · conversations.js
 *   settings.js · users.js · user-settings.js · maintenance.js
 */

const _impl = process.env.SUPABASE_DB_URL
  ? await import("./db-supabase.js")
  : await import("./db-sqlite/index.js");

export const {
  sql,
  runInTransaction,
  // Sessions
  upsertSession,
  updateSessionGitRoot,
  updateSessionStatus,
  updateSessionClaudeId,
  touchSessionActive,
  getSession,
  getActiveSessions,
  getAllSessions,
  findActiveSessionByDir,
  findRecentSessionByDir,
  findActiveSessionByGitRoot,
  findRecentSessionByGitRoot,
  getAllSessionsByUser,
  deleteSession,
  // Events
  insertEvent,
  insertEventRow,
  getEvent,
  getSessionEvents,
  getRecentEvents,
  getRecentEventsSlim,
  getRecentEventsByUser,
  getRecentEventsSlimByUser,
  // Session aliases
  getAlias,
  insertAlias,
  // Agents
  insertAgent,
  getSessionAgents,
  getSessionAgentCount,
  getRecentAgents,
  getRecentAgentsSlim,
  // Worktrees
  getWorktree,
  getWorktreeByBranch,
  getSessionWorktrees,
  getAllActiveWorktrees,
  insertWorktree,
  updateWorktreeStats,
  updateWorktreeStatus,
  updateWorktreeConflicts,
  deleteWorktreeRow,
  // Craft agents
  getAllCraftAgents,
  getCraftAgent,
  insertCraftAgent,
  updateCraftAgent,
  deleteCraftAgent,
  // Craft recipes
  getAllCraftRecipes,
  getCraftRecipe,
  insertCraftRecipe,
  updateCraftRecipe,
  deleteCraftRecipe,
  // Conversations
  getConversation,
  upsertConversation,
  appendMessages,
  deleteConversation,
  // Settings
  getAllSettings,
  getSetting,
  upsertSetting,
  deleteSetting,
  // Users & auth
  getUserById,
  getUserByGoogleId,
  getUserByApiKey,
  upsertUser,
  updateUserApiKey,
  // User settings
  getUserSettings,
  getUserSetting,
  upsertUserSetting,
  deleteUserSetting,
  // Maintenance
  deduplicateSessions,
  reconcileOrphanedSessions,
  pruneOldData,
} = _impl;
