/**
 * db-pg.js — PostgreSQL/Supabase replacement for the SQLite db.js.
 *
 * Covers the first half of db.js responsibilities:
 *   - Connection setup (postgres.js, pool of 20)
 *   - Session operations
 *   - Event operations
 *   - Session alias operations
 *
 * NOT included here (handled separately):
 *   - Agent operations (insertAgent, getSessionAgents, etc.)
 *   - Worktree operations
 *   - Crafting operations (craft_agents, craft_recipes)
 *   - deleteSession, deduplicateSessions, pruneOldData, reconcileOrphanedSessions
 *   - Re-exports from session-resolver.js
 *
 * Environment variables:
 *   SUPABASE_DB_URL — PostgreSQL connection string (required)
 */

import postgres from "postgres";

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const connectionString = process.env.SUPABASE_DB_URL;
if (!connectionString) {
  throw new Error("SUPABASE_DB_URL environment variable is required");
}

export const sql = postgres(connectionString, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
});

// ---------------------------------------------------------------------------
// Transaction helper
// ---------------------------------------------------------------------------

/**
 * Wraps a function in a PostgreSQL transaction via sql.begin().
 * The function receives a `tx` tagged-template sql object scoped to the transaction.
 *
 * @template T
 * @param {(tx: postgres.TransactionSql) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function runInTransaction(fn) {
  return sql.begin(fn);
}

// ---------------------------------------------------------------------------
// Session operations
// ---------------------------------------------------------------------------

/**
 * Insert or update a session row. Update semantics:
 * - `model`: keeps existing value if the new value is NULL
 * - `project_dir`: only updated when the new value is known ('unknown' won't overwrite a real path)
 * - `worktree_dir`: keeps existing value if not provided; '__clear__' sets it to NULL
 * - `git_root`: keeps existing value if not provided
 * - `current_claude_session_id`: NULL input is a no-op (avoids clobbering the real session ID
 *   with an ephemeral subprocess ID while a prompt is active)
 *
 * @param {{ id: string, projectDir: string, worktreeDir?: string, gitRoot?: string,
 *            status: string, model?: string, currentClaudeSessionId?: string }} params
 */
export async function upsertSession({
  id,
  projectDir,
  worktreeDir,
  gitRoot,
  status,
  model,
  currentClaudeSessionId,
}) {
  const result = await sql`
    INSERT INTO sessions (id, project_dir, worktree_dir, git_root, status, model, current_claude_session_id)
    VALUES (${id}, ${projectDir}, ${worktreeDir ?? null}, ${gitRoot ?? null}, ${status}, ${model ?? null}, ${currentClaudeSessionId ?? null})
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      model = COALESCE(EXCLUDED.model, sessions.model),
      project_dir = CASE
        WHEN EXCLUDED.project_dir != 'unknown'
          AND (sessions.project_dir = 'unknown' OR sessions.project_dir IS NULL)
          THEN EXCLUDED.project_dir
        ELSE sessions.project_dir
      END,
      worktree_dir = CASE
        WHEN EXCLUDED.worktree_dir = '__clear__' THEN NULL
        ELSE COALESCE(EXCLUDED.worktree_dir, sessions.worktree_dir)
      END,
      git_root = COALESCE(EXCLUDED.git_root, sessions.git_root),
      current_claude_session_id = COALESCE(EXCLUDED.current_claude_session_id, sessions.current_claude_session_id),
      last_seen_at = NOW()
  `;
  return { changes: result.count };
}

/**
 * Backfills a session's git_root once it has been resolved asynchronously.
 *
 * @param {string} id
 * @param {string} gitRoot
 */
export async function updateSessionGitRoot(id, gitRoot) {
  const result = await sql`
    UPDATE sessions
    SET git_root = COALESCE(${gitRoot}, git_root)
    WHERE id = ${id}
  `;
  return { changes: result.count };
}

/**
 * Updates the status of a session and its last_seen_at timestamp.
 *
 * @param {string} id
 * @param {string} status
 */
export async function updateSessionStatus(id, status) {
  const result = await sql`
    UPDATE sessions
    SET status = ${status}, last_seen_at = NOW()
    WHERE id = ${id}
  `;
  return { changes: result.count };
}

/**
 * Marks a session active and refreshes its last_seen_at timestamp.
 *
 * @param {string} id
 */
export async function touchSessionActive(id) {
  const result = await sql`
    UPDATE sessions
    SET status = 'active', last_seen_at = NOW()
    WHERE id = ${id}
  `;
  return { changes: result.count };
}

/**
 * Retrieves a single session by its ID.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getSession(id) {
  const [row] = await sql`SELECT * FROM sessions WHERE id = ${id}`;
  return row ?? null;
}

/**
 * Retrieves all active sessions, ordered by start time (newest first).
 *
 * @returns {Promise<object[]>}
 */
export async function getActiveSessions() {
  return sql`SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at DESC`;
}

/**
 * Retrieves up to 50 of the most recent sessions.
 *
 * @returns {Promise<object[]>}
 */
export async function getAllSessions() {
  return sql`SELECT * FROM sessions ORDER BY started_at DESC LIMIT 50`;
}

/**
 * Finds the most recently active session for a given project directory.
 *
 * @param {string} projectDir
 * @returns {Promise<object|null>}
 */
export async function findActiveSessionByDir(projectDir) {
  const [row] = await sql`
    SELECT id, git_root FROM sessions
    WHERE project_dir = ${projectDir} AND status = 'active'
    ORDER BY last_seen_at DESC
    LIMIT 1
  `;
  return row ?? null;
}

/**
 * Finds a session for a project directory that was seen in the last 30 minutes.
 *
 * @param {string} projectDir
 * @returns {Promise<object|null>}
 */
export async function findRecentSessionByDir(projectDir) {
  const [row] = await sql`
    SELECT id, git_root FROM sessions
    WHERE project_dir = ${projectDir}
      AND status = 'active'
      AND last_seen_at >= NOW() - INTERVAL '30 minutes'
    ORDER BY last_seen_at DESC
    LIMIT 1
  `;
  return row ?? null;
}

/**
 * Finds an active session that shares the same git root.
 *
 * @param {string} gitRoot
 * @returns {Promise<object|null>}
 */
export async function findActiveSessionByGitRoot(gitRoot) {
  const [row] = await sql`
    SELECT id, git_root FROM sessions
    WHERE git_root = ${gitRoot} AND status = 'active'
    ORDER BY last_seen_at DESC
    LIMIT 1
  `;
  return row ?? null;
}

/**
 * Finds a recent session that shares the same git root (seen within last 30 minutes).
 *
 * @param {string} gitRoot
 * @returns {Promise<object|null>}
 */
export async function findRecentSessionByGitRoot(gitRoot) {
  const [row] = await sql`
    SELECT id, git_root FROM sessions
    WHERE git_root = ${gitRoot}
      AND status = 'active'
      AND last_seen_at >= NOW() - INTERVAL '30 minutes'
    ORDER BY last_seen_at DESC
    LIMIT 1
  `;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Event operations
// ---------------------------------------------------------------------------

/**
 * Inserts a new event into the database and returns the new row's numeric ID.
 *
 * @param {{ sessionId: string, type: string, toolName?: string, filePath?: string,
 *            summary?: string, payload?: string }} params
 * @returns {Promise<{ id: number }>}
 */
export async function insertEvent({ sessionId, type, toolName, filePath, summary, payload }) {
  const [row] = await sql`
    INSERT INTO events (session_id, type, tool_name, file_path, summary, payload)
    VALUES (${sessionId}, ${type}, ${toolName ?? null}, ${filePath ?? null}, ${summary ?? null}, ${payload ?? null})
    RETURNING id
  `;
  return { id: Number(row.id) };
}

/**
 * Inserts an event row and returns its numeric ID.
 * Drop-in replacement for the SQLite pattern that used lastInsertRowid.
 *
 * @param {{ sessionId: string, type: string, toolName?: string, filePath?: string,
 *            summary?: string, payload?: string }} params
 * @returns {Promise<number>}
 */
export async function insertEventRow(params) {
  const { id } = await insertEvent(params);
  return id;
}

/**
 * Retrieves a single event by its ID.
 *
 * @param {number|string} id
 * @returns {Promise<object|null>}
 */
export async function getEvent(id) {
  const [row] = await sql`SELECT * FROM events WHERE id = ${id}`;
  return row ?? null;
}

/**
 * Retrieves up to 200 events for a specific session, newest first.
 *
 * @param {string} sessionId
 * @returns {Promise<object[]>}
 */
export async function getSessionEvents(sessionId) {
  return sql`
    SELECT * FROM events
    WHERE session_id = ${sessionId}
    ORDER BY created_at DESC
    LIMIT 200
  `;
}

/**
 * Retrieves up to 100 most recent events across all sessions, joined with project_dir.
 *
 * @returns {Promise<object[]>}
 */
export async function getRecentEvents() {
  return sql`
    SELECT e.*, s.project_dir
    FROM events e
    JOIN sessions s ON e.session_id = s.id
    ORDER BY e.created_at DESC
    LIMIT 100
  `;
}

/**
 * Slim version for WS init — excludes the full payload column to avoid multi-MB init messages.
 * Returns a boolean "hasPayload" instead.
 *
 * @returns {Promise<object[]>}
 */
export async function getRecentEventsSlim() {
  return sql`
    SELECT e.id, e.session_id, e.type, e.tool_name, e.file_path, e.summary,
           e.payload IS NOT NULL AS "hasPayload", e.created_at, s.project_dir
    FROM events e
    JOIN sessions s ON e.session_id = s.id
    ORDER BY e.created_at DESC
    LIMIT 100
  `;
}

// ---------------------------------------------------------------------------
// Session alias operations
// ---------------------------------------------------------------------------

/**
 * Retrieves the alias row for a Claude session ID.
 *
 * @param {string} claudeSessionId
 * @returns {Promise<object|null>}
 */
export async function getAlias(claudeSessionId) {
  const [row] = await sql`
    SELECT dashboard_session_id
    FROM session_aliases
    WHERE claude_session_id = ${claudeSessionId}
  `;
  return row ?? null;
}

/**
 * Creates or updates an alias between a Claude session ID and a dashboard session ID.
 * Equivalent to SQLite's INSERT OR REPLACE.
 *
 * @param {string} claudeSessionId
 * @param {string} dashboardSessionId
 */
export async function insertAlias(claudeSessionId, dashboardSessionId) {
  const result = await sql`
    INSERT INTO session_aliases (claude_session_id, dashboard_session_id)
    VALUES (${claudeSessionId}, ${dashboardSessionId})
    ON CONFLICT (claude_session_id) DO UPDATE
      SET dashboard_session_id = EXCLUDED.dashboard_session_id
  `;
  return { changes: result.count };
}

// ---------------------------------------------------------------------------
// Conversation history (Agent SDK)
// ---------------------------------------------------------------------------

/**
 * Retrieves a conversation by its ID.
 *
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getConversation(id) {
  const [row] = await sql`SELECT * FROM conversations WHERE id = ${id}`;
  return row ?? null;
}

/**
 * Inserts or updates a conversation record.
 * On conflict, updates messages, and uses COALESCE to avoid overwriting
 * existing system_prompt, model, or total_tokens with NULL values.
 *
 * @param {{ id: string, messages: object[], systemPrompt?: string, model?: string, totalTokens?: number }} params
 */
export async function upsertConversation({ id, messages, systemPrompt, model, totalTokens }) {
  await sql`
    INSERT INTO conversations (id, messages, system_prompt, model, total_tokens)
    VALUES (${id}, ${JSON.stringify(messages)}, ${systemPrompt ?? null}, ${model ?? null}, ${totalTokens ?? 0})
    ON CONFLICT (id) DO UPDATE SET
      messages = ${JSON.stringify(messages)},
      system_prompt = COALESCE(${systemPrompt}, conversations.system_prompt),
      model = COALESCE(${model}, conversations.model),
      total_tokens = COALESCE(${totalTokens}, conversations.total_tokens),
      updated_at = NOW()
  `;
}

/**
 * Appends new messages to an existing conversation's messages array.
 * Uses JSONB concatenation operator (||) so the array grows atomically.
 *
 * @param {string} id
 * @param {object[]} newMessages
 */
export async function appendMessages(id, newMessages) {
  await sql`
    UPDATE conversations SET
      messages = conversations.messages || ${JSON.stringify(newMessages)}::jsonb,
      updated_at = NOW()
    WHERE id = ${id}
  `;
}

/**
 * Deletes a conversation by its ID.
 *
 * @param {string} id
 */
export async function deleteConversation(id) {
  await sql`DELETE FROM conversations WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function getAllSettings() {
  return sql`SELECT * FROM settings ORDER BY key`;
}

export async function getSetting(key) {
  const [row] = await sql`SELECT * FROM settings WHERE key = ${key}`;
  return row ?? null;
}

export async function upsertSetting(key, value, encrypted = false) {
  await sql`
    INSERT INTO settings (key, value, encrypted, updated_at)
    VALUES (${key}, ${value}, ${encrypted}, NOW())
    ON CONFLICT (key) DO UPDATE SET
      value = ${value},
      encrypted = ${encrypted},
      updated_at = NOW()
  `;
}

export async function deleteSetting(key) {
  await sql`DELETE FROM settings WHERE key = ${key}`;
}
