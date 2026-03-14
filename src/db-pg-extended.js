/**
 * db-pg-extended.js
 *
 * Second half of the Supabase/PostgreSQL database layer.
 * Imports `sql` from `./db-pg.js` and exports agent, worktree, crafting,
 * and maintenance operations that mirror the corresponding exports from db.js.
 *
 * All functions are async and use postgres.js tagged-template queries.
 */

import { sql } from "./db-pg.js";

// ---------------------------------------------------------------------------
// Agent (sub-agent) tracking
// ---------------------------------------------------------------------------

/**
 * Inserts a new sub-agent record.
 *
 * @param {{ sessionId: string, eventId: number|null, description: string|null, agentType: string|null, prompt: string|null, status: string }} params
 * @returns {Promise<{ id: number }>}
 */
export async function insertAgent({ sessionId, eventId, description, agentType, prompt, status }) {
  const [row] = await sql`
    INSERT INTO agents (session_id, event_id, description, agent_type, prompt, status)
    VALUES (${sessionId}, ${eventId ?? null}, ${description ?? null}, ${agentType ?? null}, ${prompt ?? null}, ${status ?? "completed"})
    RETURNING id
  `;
  return row;
}

/**
 * Retrieves all agents associated with a session, newest first.
 *
 * @param {string} sessionId
 * @returns {Promise<object[]>}
 */
export async function getSessionAgents(sessionId) {
  return sql`
    SELECT * FROM agents
    WHERE session_id = ${sessionId}
    ORDER BY created_at DESC
  `;
}

/**
 * Counts the number of agents associated with a session.
 *
 * @param {string} sessionId
 * @returns {Promise<{ count: number }>}
 */
export async function getSessionAgentCount(sessionId) {
  const [row] = await sql`
    SELECT COUNT(*)::int AS count FROM agents WHERE session_id = ${sessionId}
  `;
  return row;
}

/**
 * Retrieves up to 500 most recent agent runs across all sessions.
 *
 * @returns {Promise<object[]>}
 */
export async function getRecentAgents() {
  return sql`
    SELECT * FROM agents ORDER BY created_at DESC LIMIT 500
  `;
}

/**
 * Slim version of getRecentAgents — excludes the prompt column to reduce
 * WebSocket init payload size (prompt fields can be large).
 *
 * @returns {Promise<object[]>}
 */
export async function getRecentAgentsSlim() {
  return sql`
    SELECT id, session_id, event_id, description, agent_type, status, created_at
    FROM agents
    ORDER BY created_at DESC LIMIT 500
  `;
}

// ---------------------------------------------------------------------------
// Worktree (PR-like review) tracking
// ---------------------------------------------------------------------------

/**
 * Retrieves a single worktree by its ID.
 *
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export async function getWorktree(id) {
  const [row] = await sql`SELECT * FROM worktrees WHERE id = ${id}`;
  return row ?? null;
}

/**
 * Retrieves a worktree by session ID and branch name.
 *
 * @param {string} sessionId
 * @param {string} branchName
 * @returns {Promise<object|null>}
 */
export async function getWorktreeByBranch(sessionId, branchName) {
  const [row] = await sql`
    SELECT * FROM worktrees
    WHERE session_id = ${sessionId} AND branch_name = ${branchName}
  `;
  return row ?? null;
}

/**
 * Retrieves all worktrees for a specific session, newest first.
 *
 * @param {string} sessionId
 * @returns {Promise<object[]>}
 */
export async function getSessionWorktrees(sessionId) {
  return sql`
    SELECT * FROM worktrees
    WHERE session_id = ${sessionId}
    ORDER BY created_at DESC
  `;
}

/**
 * Retrieves all active worktrees (status pending or ready).
 *
 * @returns {Promise<object[]>}
 */
export async function getAllActiveWorktrees() {
  return sql`
    SELECT * FROM worktrees
    WHERE status IN ('pending', 'ready')
    ORDER BY created_at DESC
  `;
}

/**
 * Inserts or updates a worktree record for a session and branch.
 * On conflict (session_id, branch_name), updates description, agent_id, status, and updated_at.
 *
 * @param {{ sessionId: string, branchName: string, baseBranch: string, description: string|null, agentId: string|null, status: string }} params
 * @returns {Promise<{ id: number }>}
 */
export async function insertWorktree({ sessionId, branchName, baseBranch, description, agentId, status }) {
  const [row] = await sql`
    INSERT INTO worktrees (session_id, branch_name, base_branch, description, agent_id, status)
    VALUES (${sessionId}, ${branchName}, ${baseBranch ?? "main"}, ${description ?? null}, ${agentId ?? null}, ${status ?? "pending"})
    ON CONFLICT (session_id, branch_name) DO UPDATE SET
      description = EXCLUDED.description,
      agent_id    = EXCLUDED.agent_id,
      status      = EXCLUDED.status,
      updated_at  = NOW()
    RETURNING id
  `;
  return row;
}

/**
 * Updates diff statistics and status for a worktree.
 *
 * @param {number} id
 * @param {{ filesChanged: number, insertions: number, deletions: number, diffStat: string|null, status: string }} stats
 * @returns {Promise<void>}
 */
export async function updateWorktreeStats(id, { filesChanged, insertions, deletions, diffStat, status }) {
  await sql`
    UPDATE worktrees SET
      files_changed = ${filesChanged ?? 0},
      insertions    = ${insertions ?? 0},
      deletions     = ${deletions ?? 0},
      diff_stat     = ${diffStat ?? null},
      status        = ${status},
      updated_at    = NOW()
    WHERE id = ${id}
  `;
}

/**
 * Updates the status of a worktree.
 *
 * @param {number} id
 * @param {string} status
 * @returns {Promise<void>}
 */
export async function updateWorktreeStatus(id, status) {
  await sql`
    UPDATE worktrees SET status = ${status}, updated_at = NOW()
    WHERE id = ${id}
  `;
}

/**
 * Updates conflict information for a worktree.
 *
 * @param {number} id
 * @param {string|null} conflictInfo
 * @returns {Promise<void>}
 */
export async function updateWorktreeConflicts(id, conflictInfo) {
  await sql`
    UPDATE worktrees SET conflict_info = ${conflictInfo ?? null}, updated_at = NOW()
    WHERE id = ${id}
  `;
}

/**
 * Deletes a worktree record by its ID.
 *
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function deleteWorktreeRow(id) {
  await sql`DELETE FROM worktrees WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// Crafting workbench — agents
// ---------------------------------------------------------------------------

/**
 * Retrieves all crafting agents, ordered by name.
 *
 * @returns {Promise<object[]>}
 */
export async function getAllCraftAgents() {
  return sql`SELECT * FROM craft_agents ORDER BY name`;
}

/**
 * Retrieves a single crafting agent by its ID.
 *
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export async function getCraftAgent(id) {
  const [row] = await sql`SELECT * FROM craft_agents WHERE id = ${id}`;
  return row ?? null;
}

/**
 * Inserts a new crafting agent and returns the full row.
 *
 * @param {{ name: string, description: string|null, promptSnippet: string, icon: string, color: string, tags: string, modelPreference: string|null }} params
 * @returns {Promise<object>}
 */
export async function insertCraftAgent({ name, description, promptSnippet, icon, color, tags, modelPreference }) {
  const [row] = await sql`
    INSERT INTO craft_agents (name, description, prompt_snippet, icon, color, tags, model_preference)
    VALUES (
      ${name},
      ${description ?? null},
      ${promptSnippet},
      ${icon ?? "default"},
      ${color ?? "#4ade80"},
      ${tags ?? "[]"},
      ${modelPreference ?? null}
    )
    RETURNING *
  `;
  return row;
}

/**
 * Updates an existing crafting agent and returns the updated row.
 *
 * @param {number} id
 * @param {{ name: string, description: string|null, promptSnippet: string, icon: string, color: string, tags: string, modelPreference: string|null }} params
 * @returns {Promise<object|null>}
 */
export async function updateCraftAgent(id, { name, description, promptSnippet, icon, color, tags, modelPreference }) {
  const [row] = await sql`
    UPDATE craft_agents SET
      name             = ${name},
      description      = ${description ?? null},
      prompt_snippet   = ${promptSnippet},
      icon             = ${icon ?? "default"},
      color            = ${color ?? "#4ade80"},
      tags             = ${tags ?? "[]"},
      model_preference = ${modelPreference ?? null},
      updated_at       = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  return row ?? null;
}

/**
 * Deletes a crafting agent by its ID.
 *
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function deleteCraftAgent(id) {
  await sql`DELETE FROM craft_agents WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// Crafting workbench — recipes
// ---------------------------------------------------------------------------

/**
 * Retrieves all crafting recipes, newest first (by updated_at).
 *
 * @returns {Promise<object[]>}
 */
export async function getAllCraftRecipes() {
  return sql`SELECT * FROM craft_recipes ORDER BY updated_at DESC`;
}

/**
 * Retrieves a single crafting recipe by its ID.
 *
 * @param {number} id
 * @returns {Promise<object|null>}
 */
export async function getCraftRecipe(id) {
  const [row] = await sql`SELECT * FROM craft_recipes WHERE id = ${id}`;
  return row ?? null;
}

/**
 * Inserts a new crafting recipe and returns the full row.
 *
 * @param {{ name: string, description: string|null, synthesizedPrompt: string|null, ingredientIds: string, icon: string, color: string, tags: string, modelPreference: string|null }} params
 * @returns {Promise<object>}
 */
export async function insertCraftRecipe({ name, description, synthesizedPrompt, ingredientIds, icon, color, tags, modelPreference }) {
  const [row] = await sql`
    INSERT INTO craft_recipes (name, description, synthesized_prompt, ingredient_ids, icon, color, tags, model_preference)
    VALUES (
      ${name},
      ${description ?? null},
      ${synthesizedPrompt ?? null},
      ${ingredientIds ?? "[]"},
      ${icon ?? "#fbbf24"},
      ${color ?? "#fbbf24"},
      ${tags ?? "[]"},
      ${modelPreference ?? null}
    )
    RETURNING *
  `;
  return row;
}

/**
 * Updates an existing crafting recipe and returns the updated row.
 *
 * @param {number} id
 * @param {{ name: string, description: string|null, synthesizedPrompt: string|null, ingredientIds: string, icon: string, color: string, tags: string, modelPreference: string|null }} params
 * @returns {Promise<object|null>}
 */
export async function updateCraftRecipe(id, { name, description, synthesizedPrompt, ingredientIds, icon, color, tags, modelPreference }) {
  const [row] = await sql`
    UPDATE craft_recipes SET
      name               = ${name},
      description        = ${description ?? null},
      synthesized_prompt = ${synthesizedPrompt ?? null},
      ingredient_ids     = ${ingredientIds ?? "[]"},
      icon               = ${icon ?? "#fbbf24"},
      color              = ${color ?? "#fbbf24"},
      tags               = ${tags ?? "[]"},
      model_preference   = ${modelPreference ?? null},
      updated_at         = NOW()
    WHERE id = ${id}
    RETURNING *
  `;
  return row ?? null;
}

/**
 * Deletes a crafting recipe by its ID.
 *
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function deleteCraftRecipe(id) {
  await sql`DELETE FROM craft_recipes WHERE id = ${id}`;
}

// ---------------------------------------------------------------------------
// Maintenance / cleanup
// ---------------------------------------------------------------------------

/**
 * Delete a session and all its associated data (worktrees, agents, events, aliases).
 * Refuses to delete sessions that are still active.
 *
 * This mirrors the SQLite `deleteSession()` from db.js, including the
 * "must not be active" guard.
 *
 * @param {string} sessionId
 * @returns {Promise<boolean>} Whether the session was deleted
 */
export async function deleteSession(sessionId) {
  let deleted = false;

  await sql.begin(async (tx) => {
    const [session] = await tx`SELECT id, status FROM sessions WHERE id = ${sessionId}`;
    if (!session) return;
    if (session.status === "active") return;

    await tx`DELETE FROM worktrees         WHERE session_id = ${sessionId}`;
    await tx`DELETE FROM agents            WHERE session_id = ${sessionId}`;
    await tx`DELETE FROM events            WHERE session_id = ${sessionId}`;
    await tx`DELETE FROM session_aliases   WHERE dashboard_session_id = ${sessionId}`;
    await tx`DELETE FROM sessions          WHERE id = ${sessionId}`;

    deleted = true;
  });

  return deleted;
}

/**
 * Merges duplicate active sessions for the same project_dir.
 * Keeps the oldest session (lowest id), re-parents all data from duplicates.
 *
 * Uses STRING_AGG instead of SQLite's GROUP_CONCAT.
 * Intended to run once at server startup to clean up any TOCTOU-race duplicates.
 *
 * @returns {Promise<number>} Number of duplicate groups found (each may contain multiple dupes)
 */
export async function deduplicateSessions() {
  const dupes = await sql`
    SELECT project_dir, STRING_AGG(id, ',' ORDER BY id) AS ids
    FROM sessions
    WHERE status = 'active'
    GROUP BY project_dir
    HAVING COUNT(*) > 1
  `;

  for (const { project_dir, ids } of dupes) {
    const idList = ids.split(",");
    const keep = idList[0];
    const remove = idList.slice(1);

    await sql.begin(async (tx) => {
      for (const id of remove) {
        // Fetch git_root from duplicate before deleting it
        const [dup] = await tx`SELECT git_root FROM sessions WHERE id = ${id}`;

        await tx`
          UPDATE session_aliases SET dashboard_session_id = ${keep}
          WHERE dashboard_session_id = ${id}
        `;
        await tx`UPDATE events    SET session_id = ${keep} WHERE session_id = ${id}`;
        await tx`UPDATE agents    SET session_id = ${keep} WHERE session_id = ${id}`;

        // Remove conflicting worktrees before re-parenting
        await tx`
          DELETE FROM worktrees
          WHERE session_id = ${id}
            AND branch_name IN (
              SELECT branch_name FROM worktrees WHERE session_id = ${keep}
            )
        `;
        await tx`UPDATE worktrees SET session_id = ${keep} WHERE session_id = ${id}`;

        // Backfill git_root on the canonical session if available from the duplicate
        if (dup?.git_root) {
          await tx`
            UPDATE sessions
            SET git_root = COALESCE(git_root, ${dup.git_root})
            WHERE id = ${keep}
          `;
        }

        await tx`DELETE FROM sessions WHERE id = ${id}`;
      }
    });

    console.log(`[dedup] Merged ${remove.length} duplicate session(s) for ${project_dir} → ${keep}`);
  }

  return dupes.length;
}

/**
 * Mark active sessions as stopped if they haven't been seen in 30 minutes.
 * Runs at startup to clean up sessions orphaned by a server crash.
 *
 * @returns {Promise<number>} Number of sessions marked as stopped.
 */
export async function reconcileOrphanedSessions() {
  const rows = await sql`
    UPDATE sessions
    SET status = 'stopped'
    WHERE status = 'active'
      AND last_seen_at < NOW() - INTERVAL '30 minutes'
    RETURNING id
  `;
  return rows.length;
}

/**
 * Prune old data to prevent unbounded database growth.
 * Deletes events and stopped sessions older than DATA_RETENTION_DAYS (default 30).
 *
 * Uses PostgreSQL's `make_interval(days => n)` instead of SQLite's datetime modifier.
 *
 * @returns {Promise<{ eventsDeleted: number, sessionsDeleted: number }>}
 */
export async function pruneOldData() {
  const retentionDays = Number(process.env.DATA_RETENTION_DAYS) || 30;

  const [eventsResult] = await sql`
    WITH deleted AS (
      DELETE FROM events
      WHERE created_at < NOW() - make_interval(days => ${retentionDays})
      RETURNING id
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `;

  const [sessionsResult] = await sql`
    WITH deleted AS (
      DELETE FROM sessions
      WHERE status = 'stopped'
        AND last_seen_at < NOW() - make_interval(days => ${retentionDays})
      RETURNING id
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `;

  return {
    eventsDeleted: eventsResult.count,
    sessionsDeleted: sessionsResult.count,
  };
}
