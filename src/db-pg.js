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
 * Insert or update a session row with intelligent merge semantics.
 *
 * This function implements sophisticated conflict resolution when updating existing sessions:
 * - **INSERT**: Creates a new session with all provided values (nulls for optional fields)
 * - **UPDATE (on conflict)**: Applies conditional logic to preserve valuable existing data
 *
 * Update semantics by field:
 * - `status`: Always updated to the new value
 * - `model`: Preserves existing non-null value; only updates if current is NULL
 * - `project_dir`: Smart update - only overwrites if:
 *   - New value is not 'unknown', AND
 *   - Existing value is 'unknown' or NULL
 *   This prevents downgrading a known path to 'unknown'
 * - `worktree_dir`:
 *   - Special value '__clear__' explicitly sets to NULL
 *   - Otherwise, preserves existing value if new value is NULL
 * - `git_root`: Preserves existing value if new value is NULL
 * - `current_claude_session_id`: Preserves existing value if new value is NULL
 *   (prevents clobbering the real session ID with ephemeral subprocess IDs)
 * - `user_id`: Preserves existing value if it exists, otherwise uses new value
 * - `last_seen_at`: Always updated to NOW() on any upsert
 *
 * @param {Object} params - Session parameters
 * @param {string} params.id - Unique session identifier
 * @param {string} params.projectDir - Project directory path (may be 'unknown')
 * @param {string} [params.worktreeDir] - Worktree directory path or '__clear__' to explicitly null
 * @param {string} [params.gitRoot] - Git repository root path
 * @param {string} params.status - Session status (e.g., 'active', 'inactive')
 * @param {string} [params.model] - AI model identifier
 * @param {string} [params.currentClaudeSessionId] - Current Claude session ID
 * @param {string} [params.userId] - User identifier
 * @returns {Promise<{ changes: number }>} Number of rows affected (0 or 1)
 */
export async function upsertSession({
  id,
  projectDir,
  worktreeDir,
  gitRoot,
  status,
  model,
  currentClaudeSessionId,
  userId,
}) {
  const result = await sql`
    INSERT INTO sessions (id, project_dir, worktree_dir, git_root, status, model, current_claude_session_id, user_id)
    VALUES (${id}, ${projectDir}, ${worktreeDir ?? null}, ${gitRoot ?? null}, ${status}, ${model ?? null}, ${currentClaudeSessionId ?? null}, ${userId ?? null})
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
      user_id = COALESCE(sessions.user_id, EXCLUDED.user_id),
      last_seen_at = NOW()
  `;
  return { changes: result.count };
}

/**
 * Backfills a session's git_root once it has been resolved asynchronously.
 *
 * Git root resolution may happen after initial session creation. This function
 * safely updates the git_root field without affecting other session data.
 * Uses COALESCE to preserve existing value if gitRoot parameter is NULL.
 *
 * @param {string} id - Session identifier
 * @param {string} gitRoot - Git repository root path
 * @returns {Promise<{ changes: number }>} Number of rows affected (0 or 1)
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
 * This is a lightweight update that only modifies status and touch time,
 * leaving all other session fields unchanged.
 *
 * @param {string} id - Session identifier
 * @param {string} status - New session status (e.g., 'active', 'inactive', 'completed')
 * @returns {Promise<{ changes: number }>} Number of rows affected (0 or 1)
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
 * Used to indicate that a session is currently in use. This is typically
 * called periodically during active sessions to keep them from appearing stale.
 *
 * @param {string} id - Session identifier
 * @returns {Promise<{ changes: number }>} Number of rows affected (0 or 1)
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
 * @param {string} id - Session identifier
 * @returns {Promise<object|null>} Session object with all fields, or null if not found
 */
export async function getSession(id) {
  const [row] = await sql`SELECT * FROM sessions WHERE id = ${id}`;
  return row ?? null;
}

/**
 * Retrieves all active sessions, ordered by start time (newest first).
 *
 * Active sessions are those with status = 'active'. No limit is applied,
 * so this returns ALL active sessions.
 *
 * @returns {Promise<object[]>} Array of session objects
 */
export async function getActiveSessions() {
  return sql`SELECT * FROM sessions WHERE status = 'active' ORDER BY started_at DESC`;
}

/**
 * Retrieves up to 50 of the most recent sessions.
 *
 * Returns sessions of any status, ordered by start time (newest first).
 * Limited to 50 to prevent overwhelming response sizes.
 *
 * @returns {Promise<object[]>} Array of up to 50 session objects
 */
export async function getAllSessions() {
  return sql`SELECT * FROM sessions ORDER BY started_at DESC LIMIT 50`;
}

/**
 * Finds the most recently active session for a given project directory.
 *
 * Useful for resuming or locating a session when only the project path is known.
 * Returns only the id and git_root fields for efficiency.
 *
 * @param {string} projectDir - Project directory path
 * @returns {Promise<object|null>} Object with { id, git_root } or null if not found
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
 * More restrictive than findActiveSessionByDir - requires the session to have
 * been active recently (within 30 minutes). This helps ensure you're connecting
 * to a truly current session rather than a stale one.
 *
 * @param {string} projectDir - Project directory path
 * @returns {Promise<object|null>} Object with { id, git_root } or null if not found
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
 * Useful for finding sessions in monorepos or when working in different
 * directories within the same git repository. Returns only id and git_root.
 *
 * @param {string} gitRoot - Git repository root path
 * @returns {Promise<object|null>} Object with { id, git_root } or null if not found
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
 * Combines git root matching with recency check. Only returns sessions that
 * have been active in the last 30 minutes, preventing connection to stale sessions.
 *
 * @param {string} gitRoot - Git repository root path
 * @returns {Promise<object|null>} Object with { id, git_root } or null if not found
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
 * Events track actions, tool uses, errors, and other significant occurrences
 * within a session. The payload field can store large JSON data for detailed event info.
 *
 * @param {Object} params - Event parameters
 * @param {string} params.sessionId - Associated session identifier
 * @param {string} params.type - Event type (e.g., 'tool_use', 'error', 'completion')
 * @param {string} [params.toolName] - Name of tool used (if applicable)
 * @param {string} [params.filePath] - File path related to event (if applicable)
 * @param {string} [params.summary] - Brief event description
 * @param {string} [params.payload] - Detailed event data (typically JSON string)
 * @returns {Promise<{ id: number }>} Object containing the new event's numeric ID
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
 *
 * This is a convenience wrapper around insertEvent that returns just the ID number
 * instead of an object. It's a drop-in replacement for the SQLite pattern that used
 * lastInsertRowid, making migration from SQLite easier.
 *
 * @param {Object} params - Event parameters (same as insertEvent)
 * @param {string} params.sessionId - Associated session identifier
 * @param {string} params.type - Event type
 * @param {string} [params.toolName] - Name of tool used
 * @param {string} [params.filePath] - File path related to event
 * @param {string} [params.summary] - Brief event description
 * @param {string} [params.payload] - Detailed event data (JSON string)
 * @returns {Promise<number>} The new event's numeric ID
 */
export async function insertEventRow(params) {
  const { id } = await insertEvent(params);
  return id;
}

/**
 * Retrieves a single event by its ID.
 *
 * @param {number|string} id - Event identifier (accepts string or number)
 * @returns {Promise<object|null>} Event object with all fields, or null if not found
 */
export async function getEvent(id) {
  const [row] = await sql`SELECT * FROM events WHERE id = ${id}`;
  return row ?? null;
}

/**
 * Retrieves up to 200 events for a specific session, newest first.
 *
 * Limited to 200 to prevent excessive memory usage. For sessions with more than
 * 200 events, only the most recent are returned.
 *
 * @param {string} sessionId - Session identifier
 * @returns {Promise<object[]>} Array of up to 200 event objects
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
 * Performs a JOIN with the sessions table to include the project_dir field in results.
 * Useful for dashboard views showing recent activity across all projects.
 *
 * @returns {Promise<object[]>} Array of up to 100 event objects with project_dir included
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
 * Slim version for WebSocket initialization — excludes the full payload column.
 *
 * When initializing WebSocket connections, sending full event payloads can create
 * multi-megabyte messages. This version excludes the payload field and instead
 * returns a boolean "hasPayload" flag, drastically reducing message size.
 *
 * Clients can then fetch full payload for specific events as needed.
 *
 * @returns {Promise<object[]>} Array of up to 100 slim event objects with hasPayload boolean
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
 * Session aliases map between Claude's internal session IDs and dashboard session IDs,
 * enabling cross-reference between different session tracking systems.
 *
 * @param {string} claudeSessionId - Claude's session identifier
 * @returns {Promise<object|null>} Object with dashboard_session_id, or null if not found
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
 *
 * Uses INSERT ... ON CONFLICT to implement upsert behavior, equivalent to SQLite's
 * INSERT OR REPLACE. If the Claude session ID already has an alias, it updates the
 * dashboard session ID; otherwise, it creates a new mapping.
 *
 * @param {string} claudeSessionId - Claude's session identifier
 * @param {string} dashboardSessionId - Dashboard's session identifier
 * @returns {Promise<{ changes: number }>} Number of rows affected (0 or 1)
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
 * Conversations store the complete message history for Agent SDK sessions,
 * including user messages, assistant responses, and system prompts.
 *
 * @param {string} id - Conversation identifier
 * @returns {Promise<object|null>} Conversation object with messages array, or null if not found
 */
export async function getConversation(id) {
  const [row] = await sql`SELECT * FROM conversations WHERE id = ${id}`;
  return row ?? null;
}

/**
 * Inserts or updates a conversation record.
 *
 * On INSERT: Creates new conversation with all provided values
 * On UPDATE (conflict):
 * - Always replaces messages array with new value
 * - Uses COALESCE to preserve existing system_prompt, model, and total_tokens if new values are NULL
 * - Updates updated_at timestamp to NOW()
 *
 * This prevents accidentally nullifying metadata fields while updating messages.
 *
 * @param {Object} params - Conversation parameters
 * @param {string} params.id - Conversation identifier
 * @param {object[]} params.messages - Array of message objects (will be JSON stringified)
 * @param {string} [params.systemPrompt] - System prompt text
 * @param {string} [params.model] - AI model identifier
 * @param {number} [params.totalTokens] - Total token count for conversation
 * @returns {Promise<void>}
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
 *
 * Uses PostgreSQL's JSONB concatenation operator (||) to atomically append
 * messages to the existing array. This is more efficient than fetching,
 * concatenating in app code, and writing back, and prevents race conditions.
 *
 * The conversation must already exist or this will silently do nothing.
 *
 * @param {string} id - Conversation identifier
 * @param {object[]} newMessages - Array of message objects to append
 * @returns {Promise<void>}
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
 * Permanently removes the conversation and all its messages. This operation
 * cannot be undone.
 *
 * @param {string} id - Conversation identifier
 * @returns {Promise<void>}
 */
export async function deleteConversation(id) {
  await sql`DELETE FROM conversations WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/**
 * Retrieves all settings from the database, ordered by key.
 *
 * Settings are key-value pairs used for application configuration. This returns
 * all settings including both encrypted and plaintext values.
 *
 * @returns {Promise<object[]>} Array of setting objects with key, value, encrypted, updated_at
 */
export async function getAllSettings() {
  return sql`SELECT * FROM settings ORDER BY key`;
}

/**
 * Retrieves a single setting by its key.
 *
 * @param {string} key - Setting key identifier
 * @returns {Promise<object|null>} Setting object with value and metadata, or null if not found
 */
export async function getSetting(key) {
  const [row] = await sql`SELECT * FROM settings WHERE key = ${key}`;
  return row ?? null;
}

/**
 * Creates or updates a setting with the specified key and value.
 *
 * Uses INSERT ... ON CONFLICT to implement upsert behavior. On conflict,
 * updates the value, encrypted flag, and updated_at timestamp.
 *
 * @param {string} key - Setting key identifier
 * @param {string} value - Setting value (may be encrypted or plaintext)
 * @param {boolean} [encrypted=false] - Whether the value is encrypted
 * @returns {Promise<void>}
 */
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

/**
 * Deletes a setting by its key.
 *
 * Permanently removes the setting. This operation cannot be undone.
 *
 * @param {string} key - Setting key identifier
 * @returns {Promise<void>}
 */
export async function deleteSetting(key) {
  await sql`DELETE FROM settings WHERE key = ${key}`;
}
