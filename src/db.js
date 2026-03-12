import { Database } from "bun:sqlite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "..", "dashboard.db");

const db = new Database(DB_PATH, { create: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_dir TEXT NOT NULL,
    worktree_dir TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    model TEXT,
    current_claude_session_id TEXT,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    type TEXT NOT NULL,
    tool_name TEXT,
    file_path TEXT,
    summary TEXT,
    payload TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
  CREATE INDEX IF NOT EXISTS idx_events_session_created ON events(session_id, created_at DESC);

  -- Maps Claude Code CLI session_ids to canonical dashboard session IDs.
  -- Multiple CLI invocations (reconnects) for the same conversation resolve
  -- to a single dashboard session.
  CREATE TABLE IF NOT EXISTS session_aliases (
    claude_session_id TEXT PRIMARY KEY,
    dashboard_session_id TEXT NOT NULL
  );

  -- Tracks sub-agents spawned via the Agent tool within a session.
  -- Each row represents one Agent tool invocation (one sub-agent run).
  CREATE TABLE IF NOT EXISTS agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    event_id INTEGER REFERENCES events(id),
    description TEXT,
    agent_type TEXT,
    prompt TEXT,
    status TEXT NOT NULL DEFAULT 'completed',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_agents_session ON agents(session_id);

  -- Tracks worktree branches created by swarm agents for PR-like review.
  -- Each row represents a named branch with its diff against a base branch.
  CREATE TABLE IF NOT EXISTS worktrees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    branch_name TEXT NOT NULL,
    base_branch TEXT NOT NULL DEFAULT 'main',
    description TEXT,
    agent_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    files_changed INTEGER DEFAULT 0,
    insertions INTEGER DEFAULT 0,
    deletions INTEGER DEFAULT 0,
    diff_stat TEXT,
    conflict_info TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_worktrees_session ON worktrees(session_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_worktrees_branch ON worktrees(session_id, branch_name);

  -- Crafting workbench tables (agent composition UI)
  CREATE TABLE IF NOT EXISTS craft_agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    prompt_snippet TEXT NOT NULL,
    icon TEXT NOT NULL DEFAULT 'default',
    color TEXT NOT NULL DEFAULT '#4ade80',
    tags TEXT DEFAULT '[]',
    model_preference TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS craft_recipes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    synthesized_prompt TEXT,
    ingredient_ids TEXT NOT NULL DEFAULT '[]',
    icon TEXT NOT NULL DEFAULT '#fbbf24',
    color TEXT NOT NULL DEFAULT '#fbbf24',
    tags TEXT DEFAULT '[]',
    model_preference TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

/**
 * Insert or update a session row. Update semantics:
 * - `model`: keeps existing value if the new value is NULL (hooks may not always send it)
 * - `project_dir`: only updated when the new value is known ('unknown' won't overwrite a real path)
 * - `worktree_dir`: keeps existing value if not provided (worktrees set it once at creation)
 * - `current_claude_session_id`: NULL input is a no-op — callers pass NULL when a prompt
 *   subprocess is active to avoid clobbering the real session ID with an ephemeral one
 */
export const upsertSession = db.prepare(`
  INSERT INTO sessions (id, project_dir, worktree_dir, status, model, current_claude_session_id)
  VALUES ($id, $projectDir, $worktreeDir, $status, $model, $currentClaudeSessionId)
  ON CONFLICT(id) DO UPDATE SET
    status = $status,
    model = COALESCE($model, sessions.model),
    project_dir = CASE
      WHEN $projectDir != 'unknown' AND (sessions.project_dir = 'unknown' OR sessions.project_dir IS NULL)
        THEN $projectDir
      ELSE sessions.project_dir
    END,
    worktree_dir = COALESCE($worktreeDir, sessions.worktree_dir),
    current_claude_session_id = COALESCE($currentClaudeSessionId, sessions.current_claude_session_id),
    last_seen_at = datetime('now')
`);

export const updateSessionStatus = db.prepare(`
  UPDATE sessions SET status = $status, last_seen_at = datetime('now') WHERE id = $id
`);

export const insertEvent = db.prepare(`
  INSERT INTO events (session_id, type, tool_name, file_path, summary, payload)
  VALUES ($sessionId, $type, $toolName, $filePath, $summary, $payload)
  RETURNING id
`);

export const getEvent = db.prepare(`
  SELECT * FROM events WHERE id = $id
`);

export const getSession = db.prepare(`
  SELECT * FROM sessions WHERE id = $id
`);

export const getActiveSessions = db.prepare(`
  SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at DESC
`);

export const getAllSessions = db.prepare(`
  SELECT * FROM sessions ORDER BY started_at DESC LIMIT 50
`);

export const getSessionEvents = db.prepare(`
  SELECT * FROM events WHERE session_id = $sessionId ORDER BY created_at DESC LIMIT 200
`);

export const getRecentEvents = db.prepare(`
  SELECT e.*, s.project_dir FROM events e
  JOIN sessions s ON e.session_id = s.id
  ORDER BY e.created_at DESC LIMIT 100
`);

// --- Agent (sub-agent) tracking ---

export const insertAgent = db.prepare(`
  INSERT INTO agents (session_id, event_id, description, agent_type, prompt, status)
  VALUES ($sessionId, $eventId, $description, $agentType, $prompt, $status)
  RETURNING id
`);

export const getSessionAgents = db.prepare(`
  SELECT * FROM agents WHERE session_id = $sessionId ORDER BY created_at DESC
`);

export const getSessionAgentCount = db.prepare(`
  SELECT COUNT(*) as count FROM agents WHERE session_id = $sessionId
`);

// --- Worktree (PR-like review) tracking ---

export const insertWorktree = db.prepare(`
  INSERT INTO worktrees (session_id, branch_name, base_branch, description, agent_id, status)
  VALUES ($sessionId, $branchName, $baseBranch, $description, $agentId, $status)
  ON CONFLICT (session_id, branch_name) DO UPDATE SET
    description = excluded.description,
    agent_id = excluded.agent_id,
    status = excluded.status,
    updated_at = datetime('now')
  RETURNING id
`);

export const updateWorktreeStats = db.prepare(`
  UPDATE worktrees SET
    files_changed = $filesChanged,
    insertions = $insertions,
    deletions = $deletions,
    diff_stat = $diffStat,
    status = $status,
    updated_at = datetime('now')
  WHERE id = $id
`);

export const updateWorktreeStatus = db.prepare(`
  UPDATE worktrees SET status = $status, updated_at = datetime('now') WHERE id = $id
`);

export const updateWorktreeConflicts = db.prepare(`
  UPDATE worktrees SET conflict_info = $conflictInfo, updated_at = datetime('now') WHERE id = $id
`);

export const getWorktree = db.prepare(`
  SELECT * FROM worktrees WHERE id = $id
`);

export const getWorktreeByBranch = db.prepare(`
  SELECT * FROM worktrees WHERE session_id = $sessionId AND branch_name = $branchName
`);

export const getSessionWorktrees = db.prepare(`
  SELECT * FROM worktrees WHERE session_id = $sessionId ORDER BY created_at DESC
`);

export const deleteWorktreeRow = db.prepare(`
  DELETE FROM worktrees WHERE id = $id
`);

// --- Session alias resolution ---
// Prepared statements exported for use by session-resolver.js

export const getAlias = db.prepare(`
  SELECT dashboard_session_id FROM session_aliases WHERE claude_session_id = $claudeSessionId
`);

export const insertAlias = db.prepare(`
  INSERT OR REPLACE INTO session_aliases (claude_session_id, dashboard_session_id)
  VALUES ($claudeSessionId, $dashboardSessionId)
`);

export const findActiveSessionByDir = db.prepare(`
  SELECT id FROM sessions
  WHERE project_dir = $projectDir AND status = 'active'
  ORDER BY last_seen_at DESC
  LIMIT 1
`);

export const findRecentSessionByDir = db.prepare(`
  SELECT id FROM sessions
  WHERE project_dir = $projectDir AND last_seen_at >= datetime('now', '-30 minutes')
  ORDER BY last_seen_at DESC
  LIMIT 1
`);

export const findActiveSessionByGitRoot = db.prepare(`
  SELECT id, project_dir FROM sessions
  WHERE status = 'active'
  ORDER BY last_seen_at DESC
  LIMIT 50
`);

export const findRecentSessionByGitRoot = db.prepare(`
  SELECT id, project_dir FROM sessions
  WHERE last_seen_at >= datetime('now', '-30 minutes')
  ORDER BY last_seen_at DESC
  LIMIT 50
`);

// Re-export resolveSessionId and lookupSessionId from session-resolver.js
// so existing route imports from db.js continue to work unchanged.
export { resolveSessionId, lookupSessionId } from "./session-resolver.js";

export const getLastInsertRowId = () => db.query("SELECT last_insert_rowid() AS id").get();

// --- Session deletion (cascading) ---

const deleteSessionAliases = db.prepare(`
  DELETE FROM session_aliases WHERE dashboard_session_id = $sessionId
`);

const deleteSessionWorktrees = db.prepare(`
  DELETE FROM worktrees WHERE session_id = $sessionId
`);

const deleteSessionAgents = db.prepare(`
  DELETE FROM agents WHERE session_id = $sessionId
`);

const deleteSessionEvents = db.prepare(`
  DELETE FROM events WHERE session_id = $sessionId
`);

const deleteSessionRow = db.prepare(`
  DELETE FROM sessions WHERE id = $sessionId
`);

/**
 * Delete a session and all its associated data (events, agents, aliases).
 * Only deletes stopped sessions — returns false for active ones.
 *
 * @param {string} sessionId
 * @returns {boolean} Whether the session was deleted
 */
export function deleteSession(sessionId) {
  const session = getSession.get({ $id: sessionId });
  if (!session) return false;
  if (session.status === "active") return false;

  db.transaction(() => {
    deleteSessionWorktrees.run({ $sessionId: sessionId });
    deleteSessionAgents.run({ $sessionId: sessionId });
    deleteSessionEvents.run({ $sessionId: sessionId });
    deleteSessionAliases.run({ $sessionId: sessionId });
    deleteSessionRow.run({ $sessionId: sessionId });
  })();

  return true;
}

// --- Crafting workbench ---

export const getAllCraftAgents = db.prepare(`SELECT * FROM craft_agents ORDER BY name`);
export const getCraftAgent = db.prepare(`SELECT * FROM craft_agents WHERE id = $id`);
export const insertCraftAgent = db.prepare(`
  INSERT INTO craft_agents (name, description, prompt_snippet, icon, color, tags, model_preference)
  VALUES ($name, $description, $promptSnippet, $icon, $color, $tags, $modelPreference)
  RETURNING *
`);
export const updateCraftAgentStmt = db.prepare(`
  UPDATE craft_agents SET
    name = $name, description = $description, prompt_snippet = $promptSnippet,
    icon = $icon, color = $color, tags = $tags, model_preference = $modelPreference,
    updated_at = datetime('now')
  WHERE id = $id
  RETURNING *
`);
export const deleteCraftAgentStmt = db.prepare(`DELETE FROM craft_agents WHERE id = $id`);

export const getAllCraftRecipes = db.prepare(`SELECT * FROM craft_recipes ORDER BY updated_at DESC`);
export const getCraftRecipe = db.prepare(`SELECT * FROM craft_recipes WHERE id = $id`);
export const insertCraftRecipe = db.prepare(`
  INSERT INTO craft_recipes (name, description, synthesized_prompt, ingredient_ids, icon, color, tags, model_preference)
  VALUES ($name, $description, $synthesizedPrompt, $ingredientIds, $icon, $color, $tags, $modelPreference)
  RETURNING *
`);
export const updateCraftRecipeStmt = db.prepare(`
  UPDATE craft_recipes SET
    name = $name, description = $description, synthesized_prompt = $synthesizedPrompt,
    ingredient_ids = $ingredientIds, icon = $icon, color = $color, tags = $tags,
    model_preference = $modelPreference, updated_at = datetime('now')
  WHERE id = $id
  RETURNING *
`);
export const deleteCraftRecipeStmt = db.prepare(`DELETE FROM craft_recipes WHERE id = $id`);

export default db;
