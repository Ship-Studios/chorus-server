import { Database } from "bun:sqlite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, "..", "dashboard.db");

const db = new Database(DB_PATH, { create: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

/**
 * Runs a function inside a SQLite transaction (BEGIN IMMEDIATE / COMMIT).
 * IMMEDIATE mode acquires a write lock at BEGIN — prevents TOCTOU races
 * where concurrent readers all see empty state before any writer commits.
 */
export function runInTransaction(fn) {
  return db.transaction(fn)();
}

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    project_dir TEXT NOT NULL,
    worktree_dir TEXT,
    git_root TEXT,
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
  CREATE INDEX IF NOT EXISTS idx_agents_session_created ON agents(session_id, created_at DESC);

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
  CREATE INDEX IF NOT EXISTS idx_sessions_project_status ON sessions(project_dir, status);

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

const sessionColumns = db.query("PRAGMA table_info(sessions)").all();
if (!sessionColumns.some((column) => column.name === "git_root")) {
  db.exec("ALTER TABLE sessions ADD COLUMN git_root TEXT");
}

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_status_started_at ON sessions(status, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_project_status_last_seen ON sessions(project_dir, status, last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_project_last_seen ON sessions(project_dir, last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_git_root_status_last_seen ON sessions(git_root, status, last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_git_root_last_seen ON sessions(git_root, last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agents_created ON agents(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_worktrees_status_created ON worktrees(status, created_at DESC);
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
  INSERT INTO sessions (id, project_dir, worktree_dir, git_root, status, model, current_claude_session_id)
  VALUES ($id, $projectDir, $worktreeDir, $gitRoot, $status, $model, $currentClaudeSessionId)
  ON CONFLICT(id) DO UPDATE SET
    status = $status,
    model = COALESCE($model, sessions.model),
    project_dir = CASE
      WHEN $projectDir != 'unknown' AND (sessions.project_dir = 'unknown' OR sessions.project_dir IS NULL)
        THEN $projectDir
      ELSE sessions.project_dir
    END,
    worktree_dir = CASE
      WHEN $worktreeDir = '__clear__' THEN NULL
      ELSE COALESCE($worktreeDir, sessions.worktree_dir)
    END,
    git_root = COALESCE($gitRoot, sessions.git_root),
    current_claude_session_id = COALESCE($currentClaudeSessionId, sessions.current_claude_session_id),
    last_seen_at = datetime('now')
`);

/** Backfills a session's git_root once it has been resolved asynchronously. */
export const updateSessionGitRoot = db.prepare(`
  UPDATE sessions
  SET git_root = COALESCE($gitRoot, git_root)
  WHERE id = $id
`);

/** Updates the status of a session and its last_seen_at timestamp. */
export const updateSessionStatus = db.prepare(`
  UPDATE sessions SET status = $status, last_seen_at = datetime('now') WHERE id = $id
`);

/** Marks a session active and refreshes its last_seen_at timestamp. */
export const touchSessionActive = db.prepare(`
  UPDATE sessions SET status = 'active', last_seen_at = datetime('now') WHERE id = $id
`);

/** Inserts a new event into the database. */
export const insertEvent = db.prepare(`
  INSERT INTO events (session_id, type, tool_name, file_path, summary, payload)
  VALUES ($sessionId, $type, $toolName, $filePath, $summary, $payload)
  RETURNING id
`);

const insertEventFast = db.prepare(`
  INSERT INTO events (session_id, type, tool_name, file_path, summary, payload)
  VALUES ($sessionId, $type, $toolName, $filePath, $summary, $payload)
`);

/** Inserts an event row and returns its numeric ID without using RETURNING. */
export function insertEventRow(params) {
  const result = insertEventFast.run(params);
  return Number(result.lastInsertRowid);
}

/** Retrieves a single event by its ID. */
export const getEvent = db.prepare(`
  SELECT * FROM events WHERE id = $id
`);

/** Retrieves a single session by its ID. */
export const getSession = db.prepare(`
  SELECT * FROM sessions WHERE id = $id
`);

/** Retrieves all active sessions, ordered by start time (newest first). */
export const getActiveSessions = db.prepare(`
  SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at DESC
`);

/** Retrieves up to 50 of the most recent sessions. */
export const getAllSessions = db.prepare(`
  SELECT * FROM sessions ORDER BY started_at DESC LIMIT 50
`);

/** Retrieves up to 200 events for a specific session, newest first. */
export const getSessionEvents = db.prepare(`
  SELECT * FROM events WHERE session_id = $sessionId ORDER BY created_at DESC LIMIT 200
`);

/** Retrieves up to 100 most recent events across all sessions. */
export const getRecentEvents = db.prepare(`
  SELECT e.*, s.project_dir FROM events e
  JOIN sessions s ON e.session_id = s.id
  ORDER BY e.created_at DESC LIMIT 100
`);

/** Slim version for WS init — excludes payload column to avoid multi-MB init messages. */
export const getRecentEventsSlim = db.prepare(`
  SELECT e.id, e.session_id, e.type, e.tool_name, e.file_path, e.summary,
         e.payload IS NOT NULL AS hasPayload, e.created_at, s.project_dir
  FROM events e
  JOIN sessions s ON e.session_id = s.id
  ORDER BY e.created_at DESC LIMIT 100
`);

// --- Agent (sub-agent) tracking ---

/** Inserts a new sub-agent record. */
export const insertAgent = db.prepare(`
  INSERT INTO agents (session_id, event_id, description, agent_type, prompt, status)
  VALUES ($sessionId, $eventId, $description, $agentType, $prompt, $status)
  RETURNING id
`);

/** Retrieves all agents associated with a session. */
export const getSessionAgents = db.prepare(`
  SELECT * FROM agents WHERE session_id = $sessionId ORDER BY created_at DESC
`);

/** Counts the number of agents associated with a session. */
export const getSessionAgentCount = db.prepare(`
  SELECT COUNT(*) as count FROM agents WHERE session_id = $sessionId
`);

// --- Worktree (PR-like review) tracking ---

/** Inserts or updates a worktree record for a session and branch. */
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

/** Updates statistics (lines changed, etc.) for a worktree. */
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

/** Updates the status of a worktree. */
export const updateWorktreeStatus = db.prepare(`
  UPDATE worktrees SET status = $status, updated_at = datetime('now') WHERE id = $id
`);

/** Updates conflict information for a worktree. */
export const updateWorktreeConflicts = db.prepare(`
  UPDATE worktrees SET conflict_info = $conflictInfo, updated_at = datetime('now') WHERE id = $id
`);

/** Retrieves a single worktree by its ID. */
export const getWorktree = db.prepare(`
  SELECT * FROM worktrees WHERE id = $id
`);

/** Retrieves a worktree by session ID and branch name. */
export const getWorktreeByBranch = db.prepare(`
  SELECT * FROM worktrees WHERE session_id = $sessionId AND branch_name = $branchName
`);

/** Retrieves all worktrees for a specific session. */
export const getSessionWorktrees = db.prepare(`
  SELECT * FROM worktrees WHERE session_id = $sessionId ORDER BY created_at DESC
`);

/** Retrieves up to 500 most recent agent runs. */
export const getRecentAgents = db.prepare(`SELECT * FROM agents ORDER BY created_at DESC LIMIT 500`);

/** Slim version for WS init — excludes prompt column to reduce payload by ~1MB. */
export const getRecentAgentsSlim = db.prepare(`
  SELECT id, session_id, event_id, description, agent_type, status, created_at
  FROM agents ORDER BY created_at DESC LIMIT 500
`);

/** Retrieves all active worktrees (pending or ready). */
export const getAllActiveWorktrees = db.prepare(`SELECT * FROM worktrees WHERE status IN ('pending', 'ready') ORDER BY created_at DESC`);

/** Deletes a worktree record by its ID. */
export const deleteWorktreeRow = db.prepare(`
  DELETE FROM worktrees WHERE id = $id
`);

// --- Session alias resolution ---
// Prepared statements exported for use by session-resolver.js

/** Retrieves the dashboard session ID associated with a Claude session ID. */
export const getAlias = db.prepare(`
  SELECT dashboard_session_id FROM session_aliases WHERE claude_session_id = $claudeSessionId
`);

/** Creates or updates an alias between a Claude session ID and a dashboard session ID. */
export const insertAlias = db.prepare(`
  INSERT OR REPLACE INTO session_aliases (claude_session_id, dashboard_session_id)
  VALUES ($claudeSessionId, $dashboardSessionId)
`);

/** Finds the most recently active session ID for a given project directory. */
export const findActiveSessionByDir = db.prepare(`
  SELECT id, git_root FROM sessions
  WHERE project_dir = $projectDir AND status = 'active'
  ORDER BY last_seen_at DESC
  LIMIT 1
`);

/** Finds a session ID for a project directory that was seen in the last 30 minutes. */
export const findRecentSessionByDir = db.prepare(`
  SELECT id, git_root FROM sessions
  WHERE project_dir = $projectDir AND last_seen_at >= datetime('now', '-30 minutes')
  ORDER BY last_seen_at DESC
  LIMIT 1
`);

/** Finds an active session that shares the same git root. */
export const findActiveSessionByGitRoot = db.prepare(`
  SELECT id, git_root FROM sessions
  WHERE git_root = $gitRoot AND status = 'active'
  ORDER BY last_seen_at DESC
  LIMIT 1
`);

/** Finds a recent session that shares the same git root. */
export const findRecentSessionByGitRoot = db.prepare(`
  SELECT id, git_root FROM sessions
  WHERE git_root = $gitRoot AND last_seen_at >= datetime('now', '-30 minutes')
  ORDER BY last_seen_at DESC
  LIMIT 1
`);

// Re-export resolveSessionId and lookupSessionId from session-resolver.js
// so existing route imports from db.js continue to work unchanged.
export { resolveSessionId, lookupSessionId } from "./session-resolver.js";

/** Returns the ID of the last inserted row. */
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
 * Delete a stopped session and all its associated data (events, agents, aliases).
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

/** Retrieves all crafting agents, ordered by name. */
export const getAllCraftAgents = db.prepare(`SELECT * FROM craft_agents ORDER BY name`);

/** Retrieves a single crafting agent by its ID. */
export const getCraftAgent = db.prepare(`SELECT * FROM craft_agents WHERE id = $id`);

/** Inserts a new crafting agent. */
export const insertCraftAgent = db.prepare(`
  INSERT INTO craft_agents (name, description, prompt_snippet, icon, color, tags, model_preference)
  VALUES ($name, $description, $promptSnippet, $icon, $color, $tags, $modelPreference)
  RETURNING *
`);

/** Updates an existing crafting agent. */
export const updateCraftAgentStmt = db.prepare(`
  UPDATE craft_agents SET
    name = $name, description = $description, prompt_snippet = $promptSnippet,
    icon = $icon, color = $color, tags = $tags, model_preference = $modelPreference,
    updated_at = datetime('now')
  WHERE id = $id
  RETURNING *
`);

/** Deletes a crafting agent by its ID. */
export const deleteCraftAgentStmt = db.prepare(`DELETE FROM craft_agents WHERE id = $id`);

/** Retrieves all crafting recipes, newest first. */
export const getAllCraftRecipes = db.prepare(`SELECT * FROM craft_recipes ORDER BY updated_at DESC`);

/** Retrieves a single crafting recipe by its ID. */
export const getCraftRecipe = db.prepare(`SELECT * FROM craft_recipes WHERE id = $id`);

/** Inserts a new crafting recipe. */
export const insertCraftRecipe = db.prepare(`
  INSERT INTO craft_recipes (name, description, synthesized_prompt, ingredient_ids, icon, color, tags, model_preference)
  VALUES ($name, $description, $synthesizedPrompt, $ingredientIds, $icon, $color, $tags, $modelPreference)
  RETURNING *
`);

/** Updates an existing crafting recipe. */
export const updateCraftRecipeStmt = db.prepare(`
  UPDATE craft_recipes SET
    name = $name, description = $description, synthesized_prompt = $synthesizedPrompt,
    ingredient_ids = $ingredientIds, icon = $icon, color = $color, tags = $tags,
    model_preference = $modelPreference, updated_at = datetime('now')
  WHERE id = $id
  RETURNING *
`);

/** Deletes a crafting recipe by its ID. */
export const deleteCraftRecipeStmt = db.prepare(`DELETE FROM craft_recipes WHERE id = $id`);

/**
 * Merges duplicate active sessions for the same project_dir.
 * Keeps the oldest session (first created), re-parents all data from duplicates.
 * Intended to run once at server startup to clean up any existing duplicates
 * caused by the now-fixed TOCTOU race in resolveSessionId.
 */
export function deduplicateSessions() {
  const dupes = db.prepare(`
    SELECT project_dir, GROUP_CONCAT(id) as ids
    FROM sessions WHERE status = 'active'
    GROUP BY project_dir HAVING COUNT(*) > 1
  `).all();

  for (const { project_dir, ids } of dupes) {
    const idList = ids.split(",");
    const keep = idList[0];
    const remove = idList.slice(1);
    db.transaction(() => {
      for (const id of remove) {
        const dup = getSession.get({ $id: id });
        db.prepare(`UPDATE session_aliases SET dashboard_session_id = $keep WHERE dashboard_session_id = $id`)
          .run({ $keep: keep, $id: id });
        db.prepare(`UPDATE events SET session_id = $keep WHERE session_id = $id`)
          .run({ $keep: keep, $id: id });
        db.prepare(`UPDATE agents SET session_id = $keep WHERE session_id = $id`)
          .run({ $keep: keep, $id: id });
        if (dup?.git_root) {
          updateSessionGitRoot.run({ $id: keep, $gitRoot: dup.git_root });
        }
        db.prepare(`DELETE FROM sessions WHERE id = $id`).run({ $id: id });
      }
    })();
    console.log(`[dedup] Merged ${remove.length} duplicate session(s) for ${project_dir} → ${keep}`);
  }
  return dupes.length;
}

export default db;
