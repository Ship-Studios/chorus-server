/**
 * db-supabase.js — Barrel export for the Supabase/PostgreSQL database layer.
 *
 * Re-exports all database operations from db-pg.js (sessions, events, aliases)
 * and db-pg-extended.js (agents, worktrees, crafting, maintenance).
 *
 * When the migration is complete, rename this file to db.js (replacing the
 * SQLite version) and update session-resolver.js to import from here.
 *
 * Usage:
 *   import { getSession, insertEvent, deleteSession } from "./db-supabase.js";
 */

// Connection + sessions + events + aliases + transaction helper
export {
  sql,
  runInTransaction,
  upsertSession,
  updateSessionGitRoot,
  updateSessionStatus,
  touchSessionActive,
  getSession,
  getActiveSessions,
  getAllSessions,
  findActiveSessionByDir,
  findRecentSessionByDir,
  findActiveSessionByGitRoot,
  findRecentSessionByGitRoot,
  insertEvent,
  insertEventRow,
  getEvent,
  getSessionEvents,
  getRecentEvents,
  getRecentEventsSlim,
  getAlias,
  insertAlias,
  getConversation,
  upsertConversation,
  appendMessages,
  deleteConversation,
  getAllSettings,
  getSetting,
  upsertSetting,
  deleteSetting,
} from "./db-pg.js";

// Users + auth + user settings
export {
  getUserById,
  getUserByGoogleId,
  getUserByApiKey,
  upsertUser,
  updateUserApiKey,
  getAllSessionsByUser,
  getRecentEventsByUser,
  getRecentEventsSlimByUser,
  getUserSettings,
  getUserSetting,
  upsertUserSetting,
  deleteUserSetting,
} from "./db-pg-extended.js";

// Agents + worktrees + crafting + maintenance
export {
  insertAgent,
  getSessionAgents,
  getSessionAgentCount,
  getRecentAgents,
  getRecentAgentsSlim,
  getWorktree,
  getWorktreeByBranch,
  getSessionWorktrees,
  getAllActiveWorktrees,
  insertWorktree,
  updateWorktreeStats,
  updateWorktreeStatus,
  updateWorktreeConflicts,
  deleteWorktreeRow,
  getAllCraftAgents,
  getCraftAgent,
  insertCraftAgent,
  updateCraftAgent,
  deleteCraftAgent,
  getAllCraftRecipes,
  getCraftRecipe,
  insertCraftRecipe,
  updateCraftRecipe,
  deleteCraftRecipe,
  deleteSession,
  deduplicateSessions,
  reconcileOrphanedSessions,
  pruneOldData,
} from "./db-pg-extended.js";

// Re-export session resolver functions so callers can import from either
// db-supabase.js or session-resolver.js directly.
export { resolveSessionId, lookupSessionId } from "./session-resolver.js";
