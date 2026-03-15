/**
 * db-sqlite/index.js — SQLite async wrapper barrel.
 *
 * Re-exports every database function from the domain modules below, plus the
 * SQLite-compatible runInTransaction stub (which just calls fn(null) since
 * the individual helpers do not accept a tx argument).
 *
 * Import this module via db-adapter.js — do not import it directly in routes.
 */

export * from "./sessions.js";
export * from "./events.js";
export * from "./aliases.js";
export * from "./agents.js";
export * from "./worktrees.js";
export * from "./craft-agents.js";
export * from "./craft-recipes.js";
export * from "./conversations.js";
export * from "./settings.js";
export * from "./users.js";
export * from "./user-settings.js";
export * from "./maintenance.js";

export const sql = null;

export async function runInTransaction(fn) {
  return fn(null);
}
