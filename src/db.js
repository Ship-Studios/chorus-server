/**
 * Database Module for Claude Code Dashboard
 *
 * This module provides the central SQLite database interface for the dashboard server.
 * It manages session tracking, event logging, agent monitoring, user authentication,
 * and conversation history for the Claude Code Agent SDK.
 *
 * @module db
 *
 * Architecture Overview:
 * ----------------------
 * - Uses SQLite with WAL mode for concurrent reads and improved write performance
 * - Prepared statements exported for optimal performance (compiled once, executed many times)
 * - Transaction support via runInTransaction() for atomic multi-step operations
 * - Automatic schema migrations for backward compatibility
 *
 * Core Tables:
 * ------------
 * - sessions: Active and historical Claude Code sessions
 * - events: Tool invocations, file edits, and other session events
 * - agents: Sub-agent spawns via the Agent tool
 * - worktrees: Git branches created by agents for PR-like review
 * - users: User authentication and profile data
 * - conversations: Conversation history for Agent SDK sessions
 * - craft_agents/craft_recipes: Agent composition UI (crafting workbench)
 *
 * Environment Variables:
 * ----------------------
 * - DASHBOARD_DB_PATH: Custom database file location (default: ./dashboard.db)
 * - DATA_RETENTION_DAYS: Days to retain old events/sessions (default: 30)
 *
 * Performance Tuning:
 * -------------------
 * - WAL mode: Enables concurrent reads during writes
 * - 64MB page cache: Keeps frequently accessed data in memory
 * - Memory-mapped I/O: Reduces syscall overhead for large reads
 * - Optimized indexes: Composite indexes for common query patterns
 */

import { Database } from "bun:sqlite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DASHBOARD_DB_PATH
  ? resolve(process.env.DASHBOARD_DB_PATH)
  : resolve(__dirname, "..", "dashboard.db");

// Initialize database with automatic schema creation
const db = new Database(DB_PATH, { create: true });

// ---------------------------------------------------------------------------
// Database configuration and performance optimization
// ---------------------------------------------------------------------------

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA synchronous = NORMAL");      // 2-5x write throughput vs FULL (safe with WAL)
db.exec("PRAGMA cache_size = -65536");       // 64MB page cache — keeps hot sessions/events in RAM
db.exec("PRAGMA temp_store = MEMORY");       // Sort temp tables in RAM, not disk
db.exec("PRAGMA mmap_size = 268435456");     // 256MB memory-mapped reads — reduces syscall overhead
db.exec("PRAGMA optimize");                  // Update query planner statistics at startup

// ---------------------------------------------------------------------------
// Transaction Support
// ---------------------------------------------------------------------------

/**
 * Runs a function inside a SQLite transaction (BEGIN IMMEDIATE / COMMIT).
 * IMMEDIATE mode acquires a write lock at BEGIN — prevents TOCTOU races
 * where concurrent readers all see empty state before any writer commits.
 *
 * @param {Function} fn - Function to execute within the transaction
 * @returns {*} Return value of the function
 * @throws {Error} If the transaction fails and is rolled back
 *
 * @example
 * runInTransaction(() => {
 *   insertEvent.run({ sessionId: 'abc', type: 'tool_call' });
 *   updateSessionStatus.run({ id: 'abc', status: 'active' });
 * });
 */
export function runInTransaction(fn) {
  return db.transaction(fn)();
}

// ---------------------------------------------------------------------------
// Core Schema: Sessions & Events
// ---------------------------------------------------------------------------

/**
 * Sessions Table
 * --------------
 * Represents a Claude Code conversation session. Sessions can be active (ongoing)
 * or stopped (completed/terminated). Multiple CLI invocations can map to the same
 * session via the session_aliases table.
 *
 * Key Fields:
 * - id: Unique session identifier (dashboard-generated)
 * - project_dir: Working directory where the session is running
 * - worktree_dir: Git worktree directory (for agents running in isolated worktrees)
 * - git_root: Root of the git repository (resolved asynchronously)
 * - status: 'active' or 'stopped'
 * - current_claude_session_id: Latest CLI session ID associated with this session
 * - user_id: User who owns this session (added via migration below)
 */
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

  /**
   * Events Table
   * ------------
   * Records all tool invocations and significant actions within a session.
   * Events are the primary audit log for debugging and understanding session behavior.
   *
   * Key Fields:
   * - type: Event category (e.g., 'tool_call', 'agent_spawn', 'error')
   * - tool_name: Name of the tool invoked (if applicable)
   * - file_path: File affected by the event (if applicable)
   * - summary: Human-readable event description
   * - payload: JSON blob with full event details
   */
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

  /**
   * Session Aliases Table
   * ---------------------
   * Maps Claude Code CLI session_ids to canonical dashboard session IDs.
   * Multiple CLI invocations (reconnects) for the same conversation resolve
   * to a single dashboard session, enabling conversation continuity across
   * disconnects and reconnects.
   */
  CREATE TABLE IF NOT EXISTS session_aliases (
    claude_session_id TEXT PRIMARY KEY,
    dashboard_session_id TEXT NOT NULL
  );

  /**
   * Agents Table
   * ------------
   * Tracks sub-agents spawned via the Agent tool within a session.
   * Each row represents one Agent tool invocation (one sub-agent run).
   *
   * Key Fields:
   * - agent_type: Type of agent (e.g., 'explore', 'test-runner', 'plan')
   * - status: 'running', 'completed', 'failed'
   * - prompt: The task/prompt given to the agent
   * - event_id: Links to the event that spawned this agent
   */
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

  /**
   * Worktrees Table
   * ---------------
   * Tracks worktree branches created by agents for PR-like review.
   * Each row represents a named branch with its diff against a base branch.
   *
   * Key Fields:
   * - branch_name: Name of the git branch
   * - base_branch: Branch to compare against (usually 'main' or 'master')
   * - status: 'pending', 'ready', 'merged', 'abandoned'
   * - diff_stat: Summary of changes (e.g., "+123 -45")
   * - conflict_info: JSON blob describing merge conflicts (if any)
   */
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

  /**
   * Crafting Workbench Tables
   * -------------------------
   * Supports the agent composition UI where users can create custom agents
   * by combining prompt snippets and configuring behavior.
   *
   * craft_agents: Reusable agent "ingredients" with prompt snippets
   * craft_recipes: Composed agents created by combining multiple ingredients
   */
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

// ---------------------------------------------------------------------------
// Schema Migrations
// ---------------------------------------------------------------------------

/**
 * Backward-compatible schema migrations for existing databases.
 * These ALTER TABLE statements add columns that were introduced after initial
 * deployment. They check for column existence first to avoid errors on fresh
 * installations or when running migrations multiple times.
 *
 * Migration Strategy:
 * - Check PRAGMA table_info to detect missing columns
 * - Add columns with ALTER TABLE (safe because they're nullable or have defaults)
 * - Create indexes after adding foreign key columns
 *
 * Note: SQLite does not support adding foreign key constraints to existing tables,
 * so user_id uses REFERENCES but enforcement depends on PRAGMA foreign_keys=ON.
 */
const sessionColumns = db.query("PRAGMA table_info(sessions)").all();

// Migration: Add git_root column (for associating sessions with git repositories)
if (!sessionColumns.some((column) => column.name === "git_root")) {
  db.exec("ALTER TABLE sessions ADD COLUMN git_root TEXT");
}

// Migration: Add user_id column (for multi-user authentication support)
if (!sessionColumns.some((column) => column.name === "user_id")) {
  db.exec("ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id) ON DELETE SET NULL");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)");
}

// ---------------------------------------------------------------------------
// Users & Authentication Schema
// ---------------------------------------------------------------------------
/**
 * Users Table
 * -----------
 * Stores user accounts for multi-user dashboard access. Currently supports
 * Google OAuth authentication.
 *
 * Key Fields:
 * - google_id: Unique identifier from Google OAuth
 * - dashboard_api_key: Secret token for Bearer authentication (CLI to dashboard)
 * - email: User email from Google profile
 * - avatar_url: Profile picture URL
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_id TEXT UNIQUE NOT NULL,
    email TEXT NOT NULL,
    name TEXT,
    avatar_url TEXT,
    dashboard_api_key TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_api_key ON users(dashboard_api_key);

  /**
   * User Settings Table
   * -------------------
   * Key-value store for per-user configuration. Supports optional encryption
   * for sensitive values (e.g., API keys, tokens).
   *
   * Key Fields:
   * - encrypted: 1 if value is encrypted, 0 if plaintext
   * - value: Setting value (encrypted or plaintext depending on flag)
   */
  CREATE TABLE IF NOT EXISTS user_settings (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    encrypted INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, key)
  );
`);

// ---------------------------------------------------------------------------
// Conversation History (Agent SDK)
// ---------------------------------------------------------------------------

/**
 * Conversations Table
 * -------------------
 * Stores conversation history for Agent SDK sessions, enabling conversation
 * resumption and context persistence. Replaces the CLI --resume mechanism.
 *
 * Key Fields:
 * - messages: JSON array of message objects (user, assistant, tool use, etc.)
 * - system_prompt: Initial system prompt for the conversation
 * - total_tokens: Running token count for cost tracking
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    messages TEXT NOT NULL DEFAULT '[]',
    system_prompt TEXT,
    model TEXT,
    total_tokens INTEGER DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// ---------------------------------------------------------------------------
// Performance Indexes
// ---------------------------------------------------------------------------

/**
 * Composite and single-column indexes optimized for common query patterns.
 *
 * Index Strategy:
 * - Composite indexes follow the "equality, range, sort" pattern
 * - Indexes on foreign keys for efficient JOIN operations
 * - DESC indexes for "most recent" queries (newest first)
 * - Covering indexes where possible to avoid table lookups
 *
 * Query Patterns Optimized:
 * - Recent sessions by project directory
 * - Active sessions filtered by git root
 * - Events for a session sorted by time
 * - Recent agent runs across all sessions
 * - Worktree status filtering and sorting
 */
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_status_started_at ON sessions(status, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_project_status_last_seen ON sessions(project_dir, status, last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_project_last_seen ON sessions(project_dir, last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_git_root_status_last_seen ON sessions(git_root, status, last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_git_root_last_seen ON sessions(git_root, last_seen_at DESC);
  CREATE INDEX IF NOT EXISTS idx_agents_created ON agents(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_worktrees_status_created ON worktrees(status, created_at DESC);
`);

// ---------------------------------------------------------------------------
// Prepared Statements: Sessions
// ---------------------------------------------------------------------------

/**
 * Insert or update a session row. Update semantics:
 * - `model`: keeps existing value if the new value is NULL (hooks may not always send it)
 * - `project_dir`: only updated when the new value is known ('unknown' won't overwrite a real path)
 * - `worktree_dir`: keeps existing value if not provided (worktrees set it once at creation)
 * - `current_claude_session_id`: NULL input is a no-op — callers pass NULL when a prompt
 *   subprocess is active to avoid clobbering the real session ID with an ephemeral one
 */
export const upsertSession = db.prepare(`
  INSERT INTO sessions (id, project_dir, worktree_dir, git_root, status, model, current_claude_session_id, user_id)
  VALUES ($id, $projectDir, $worktreeDir, $gitRoot, $status, $model, $currentClaudeSessionId, $userId)
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
    user_id = COALESCE(sessions.user_id, $userId),
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

// ---------------------------------------------------------------------------
// Prepared Statements: Events
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Prepared Statements: Agent (Sub-Agent) Tracking
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Prepared Statements: Worktree (PR-like Review) Tracking
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Prepared Statements: Session Alias Resolution
// ---------------------------------------------------------------------------
// These statements are exported for use by session-resolver.js to implement
// the session continuity logic that maps CLI session IDs to dashboard sessions.

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
  WHERE project_dir = $projectDir AND status = 'active' AND last_seen_at >= datetime('now', '-30 minutes')
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
  WHERE git_root = $gitRoot AND status = 'active' AND last_seen_at >= datetime('now', '-30 minutes')
  ORDER BY last_seen_at DESC
  LIMIT 1
`);

/**
 * Re-export session resolver functions for convenience.
 * This maintains backward compatibility for existing route imports that expect
 * these functions to be available from db.js.
 */
export { resolveSessionId, lookupSessionId } from "./session-resolver.js";

/** Returns the ID of the last inserted row. */
export const getLastInsertRowId = () => db.query("SELECT last_insert_rowid() AS id").get();

// ---------------------------------------------------------------------------
// Session Deletion (Cascading)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Prepared Statements: Crafting Workbench
// ---------------------------------------------------------------------------

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
 *
 * This function is safe to run multiple times and will only process duplicates
 * that exist at the time of execution.
 *
 * @returns {number} Number of duplicate groups merged
 */
export function deduplicateSessions() {
  const dupes = db.prepare(`
    SELECT project_dir, GROUP_CONCAT(id) as ids
    FROM (SELECT project_dir, id FROM sessions WHERE status = 'active' ORDER BY id)
    GROUP BY project_dir HAVING COUNT(*) > 1
  `).all();

  const updateAliases = db.prepare(`UPDATE session_aliases SET dashboard_session_id = $keep WHERE dashboard_session_id = $id`);
  const updateEvents = db.prepare(`UPDATE events SET session_id = $keep WHERE session_id = $id`);
  const updateAgents = db.prepare(`UPDATE agents SET session_id = $keep WHERE session_id = $id`);
  const deleteConflictingWorktrees = db.prepare(`
    DELETE FROM worktrees
    WHERE session_id = $id
      AND branch_name IN (SELECT branch_name FROM worktrees WHERE session_id = $keep)
  `);
  const updateWorktrees = db.prepare(`UPDATE worktrees SET session_id = $keep WHERE session_id = $id`);
  const deleteSession = db.prepare(`DELETE FROM sessions WHERE id = $id`);

  for (const { project_dir, ids } of dupes) {
    const idList = ids.split(",");
    const keep = idList[0];
    const remove = idList.slice(1);
    db.transaction(() => {
      for (const id of remove) {
        const dup = getSession.get({ $id: id });
        updateAliases.run({ $keep: keep, $id: id });
        updateEvents.run({ $keep: keep, $id: id });
        updateAgents.run({ $keep: keep, $id: id });
        // Remove worktrees from the duplicate session that would conflict with
        // an existing (session_id, branch_name) row on the canonical session.
        deleteConflictingWorktrees.run({ $keep: keep, $id: id });
        updateWorktrees.run({ $keep: keep, $id: id });
        if (dup?.git_root) {
          updateSessionGitRoot.run({ $id: keep, $gitRoot: dup.git_root });
        }
        deleteSession.run({ $id: id });
      }
    })();
    console.log(`[dedup] Merged ${remove.length} duplicate session(s) for ${project_dir} → ${keep}`);
  }
  return dupes.length;
}

// ---------------------------------------------------------------------------
// Orphan reconciliation
// ---------------------------------------------------------------------------

const markStaleSessions = db.prepare(`
  UPDATE sessions SET status = 'stopped'
  WHERE status = 'active' AND last_seen_at < datetime('now', '-30 minutes')
  RETURNING id
`);

/**
 * Mark active sessions as stopped if they haven't been seen in 30 minutes.
 * Runs at startup to clean up sessions orphaned by a server crash.
 *
 * @returns {number} Number of sessions marked as stopped.
 */
export function reconcileOrphanedSessions() {
  const rows = markStaleSessions.all();
  return rows.length;
}

// ---------------------------------------------------------------------------
// Data retention / cleanup
// ---------------------------------------------------------------------------

const RETENTION_DAYS = Number(process.env.DATA_RETENTION_DAYS) || 30;

const deleteOldEvents = db.prepare(`
  DELETE FROM events WHERE created_at < datetime('now', $days || ' days')
`);

const deleteOldStoppedSessions = db.prepare(`
  DELETE FROM sessions WHERE status = 'stopped' AND last_seen_at < datetime('now', $days || ' days')
`);

/**
 * Prune old data to prevent unbounded database growth.
 * Deletes events and stopped sessions older than DATA_RETENTION_DAYS (default 30).
 * Runs a WAL checkpoint after cleanup to reclaim disk space.
 *
 * @returns {{ eventsDeleted: number, sessionsDeleted: number }}
 */
export function pruneOldData() {
  const days = `-${RETENTION_DAYS}`;
  const eventsResult = deleteOldEvents.run({ $days: days });
  const sessionsResult = deleteOldStoppedSessions.run({ $days: days });
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  return {
    eventsDeleted: eventsResult.changes,
    sessionsDeleted: sessionsResult.changes,
  };
}

// ---------------------------------------------------------------------------
// Conversation history (Agent SDK)
// ---------------------------------------------------------------------------

/** Retrieves a single conversation by its ID. */
export const getConversationStmt = db.prepare(`SELECT * FROM conversations WHERE id = $id`);

/** Inserts or updates a conversation record. */
export const upsertConversationStmt = db.prepare(`
  INSERT INTO conversations (id, messages, system_prompt, model, total_tokens)
  VALUES ($id, $messages, $systemPrompt, $model, $totalTokens)
  ON CONFLICT(id) DO UPDATE SET
    messages = $messages,
    system_prompt = COALESCE($systemPrompt, conversations.system_prompt),
    model = COALESCE($model, conversations.model),
    total_tokens = COALESCE($totalTokens, conversations.total_tokens),
    updated_at = datetime('now')
`);

/** Deletes a conversation by its ID. */
export const deleteConversationStmt = db.prepare(`DELETE FROM conversations WHERE id = $id`);

// ---------------------------------------------------------------------------
// Global Settings Schema
// ---------------------------------------------------------------------------

/**
 * Settings Table
 * --------------
 * Global key-value store for server-wide configuration. Similar to user_settings
 * but applies to all users and the server instance itself.
 *
 * Key Fields:
 * - encrypted: 1 if value is encrypted, 0 if plaintext
 * - value: Setting value (encrypted or plaintext)
 *
 * Use Cases:
 * - Feature flags
 * - Server configuration
 * - API keys and secrets (encrypted)
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    encrypted INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

export const getAllSettingsStmt = db.prepare(`SELECT * FROM settings ORDER BY key`);
export const getSettingStmt = db.prepare(`SELECT * FROM settings WHERE key = $key`);
export const upsertSettingStmt = db.prepare(`
  INSERT INTO settings (key, value, encrypted, updated_at)
  VALUES ($key, $value, $encrypted, datetime('now'))
  ON CONFLICT (key) DO UPDATE SET value = $value, encrypted = $encrypted, updated_at = datetime('now')
`);
export const deleteSettingStmt = db.prepare(`DELETE FROM settings WHERE key = $key`);

// ---------------------------------------------------------------------------
// Prepared Statements: Users & Authentication
// ---------------------------------------------------------------------------

/** Retrieves a user by their ID. */
export const getUserByIdStmt = db.prepare(`SELECT * FROM users WHERE id = $id`);

/** Retrieves a user by their Google ID. */
export const getUserByGoogleIdStmt = db.prepare(`SELECT * FROM users WHERE google_id = $googleId`);

/** Retrieves a user by their dashboard API key (for Bearer token auth). */
export const getUserByApiKeyStmt = db.prepare(`SELECT * FROM users WHERE dashboard_api_key = $apiKey`);

/** Creates or updates a user on Google ID conflict. */
export const upsertUserStmt = db.prepare(`
  INSERT INTO users (id, google_id, email, name, avatar_url, dashboard_api_key)
  VALUES ($id, $googleId, $email, $name, $avatarUrl, $apiKey)
  ON CONFLICT(google_id) DO UPDATE SET
    email = $email,
    name = $name,
    avatar_url = $avatarUrl,
    last_login_at = datetime('now')
  RETURNING *
`);

/** Regenerates a user's dashboard API key. */
export const updateUserApiKeyStmt = db.prepare(`
  UPDATE users SET dashboard_api_key = $apiKey WHERE id = $id RETURNING *
`);

/** Retrieves all sessions scoped to a specific user. */
export const getAllSessionsByUser = db.prepare(`
  SELECT * FROM sessions WHERE user_id = $userId ORDER BY started_at DESC LIMIT 50
`);

/** Retrieves recent events scoped to a specific user. */
export const getRecentEventsByUser = db.prepare(`
  SELECT e.*, s.project_dir FROM events e
  JOIN sessions s ON e.session_id = s.id
  WHERE s.user_id = $userId
  ORDER BY e.created_at DESC LIMIT 100
`);

/** Slim version of getRecentEventsByUser — excludes payload column. */
export const getRecentEventsSlimByUser = db.prepare(`
  SELECT e.id, e.session_id, e.type, e.tool_name, e.file_path, e.summary,
         e.payload IS NOT NULL AS hasPayload, e.created_at, s.project_dir
  FROM events e
  JOIN sessions s ON e.session_id = s.id
  WHERE s.user_id = $userId
  ORDER BY e.created_at DESC LIMIT 100
`);

// ---------------------------------------------------------------------------
// Prepared Statements: User Settings
// ---------------------------------------------------------------------------

/** Retrieves all settings for a specific user. */
export const getUserSettingsStmt = db.prepare(`SELECT * FROM user_settings WHERE user_id = $userId ORDER BY key`);

/** Retrieves a single setting for a specific user. */
export const getUserSettingStmt = db.prepare(`SELECT * FROM user_settings WHERE user_id = $userId AND key = $key`);

/** Creates or updates a user setting. */
export const upsertUserSettingStmt = db.prepare(`
  INSERT INTO user_settings (user_id, key, value, encrypted, updated_at)
  VALUES ($userId, $key, $value, $encrypted, datetime('now'))
  ON CONFLICT (user_id, key) DO UPDATE SET value = $value, encrypted = $encrypted, updated_at = datetime('now')
`);

/** Deletes a user setting. */
export const deleteUserSettingStmt = db.prepare(`DELETE FROM user_settings WHERE user_id = $userId AND key = $key`);

export default db;
