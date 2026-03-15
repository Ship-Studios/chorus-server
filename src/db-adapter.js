/**
 * db-adapter.js — Database backend selector.
 *
 * Auto-selects between Supabase/PostgreSQL (production) and SQLite (local dev)
 * based on whether the SUPABASE_DB_URL environment variable is set.
 *
 * When SUPABASE_DB_URL is set:
 *   All exports are the async postgres.js functions from ./db-supabase.js.
 *
 * When SUPABASE_DB_URL is NOT set:
 *   The synchronous SQLite prepared statements from ./db.js are wrapped in async
 *   functions that accept the same parameter shapes as the Supabase equivalents
 *   (plain camelCase objects), converting internally to the $-prefixed binding
 *   format that bun:sqlite expects.
 *
 * All route files and core modules should import from this file so they are
 * backend-agnostic.
 */

// ---------------------------------------------------------------------------
// Backend selection — build the implementation object at startup, then
// re-export each symbol at module scope so static analysis and tree-shaking
// work correctly.
// ---------------------------------------------------------------------------

let _impl;

if (process.env.SUPABASE_DB_URL) {
  // Supabase/PostgreSQL path — import the async layer directly.
  _impl = await import("./db-supabase.js");
} else {
  // SQLite fallback — import the synchronous prepared-statement layer and
  // wrap every export in an async function with the Supabase call convention.
  const s = await import("./db.js");

  // -------------------------------------------------------------------------
  // Transaction helper
  // -------------------------------------------------------------------------

  /**
   * Runs a function within a transaction context.
   *
   * In Supabase/PostgreSQL mode, this passes a `tx` tagged-template sql object
   * to the callback function for transaction support. In SQLite mode, we run
   * fn(null) since the individual helper functions below do not accept a tx
   * argument.
   *
   * @param {Function} fn - The callback function to execute within the transaction.
   *                        Receives a transaction object (or null in SQLite mode).
   * @returns {Promise<*>} The result of the callback function.
   */
  async function runInTransaction(fn) {
    return fn(null);
  }

  // -------------------------------------------------------------------------
  // Session operations
  // -------------------------------------------------------------------------

  /**
   * Creates or updates a session record.
   *
   * Sessions represent individual coding sessions tied to a project directory
   * and optionally to a Git repository.
   *
   * @param {Object} params - Session parameters.
   * @param {string} params.id - Unique session identifier.
   * @param {string} params.projectDir - Absolute path to the project directory.
   * @param {string} [params.worktreeDir] - Optional path to a Git worktree directory.
   * @param {string} [params.gitRoot] - Optional path to the Git repository root.
   * @param {string} params.status - Session status (e.g., "active", "inactive").
   * @param {string} [params.model] - Optional AI model identifier used in this session.
   * @param {string} [params.currentClaudeSessionId] - Optional Claude session ID.
   * @param {string} [params.userId] - Optional user ID who owns this session.
   * @returns {Promise<Object>} Database operation result.
   */
  async function upsertSession({ id, projectDir, worktreeDir, gitRoot, status, model, currentClaudeSessionId, userId }) {
    return s.upsertSession.run({
      $id: id,
      $projectDir: projectDir,
      $worktreeDir: worktreeDir ?? null,
      $gitRoot: gitRoot ?? null,
      $status: status,
      $model: model ?? null,
      $currentClaudeSessionId: currentClaudeSessionId ?? null,
      $userId: userId ?? null,
    });
  }

  /**
   * Updates the Git root path for an existing session.
   *
   * @param {string} id - Session identifier.
   * @param {string} gitRoot - New Git repository root path.
   * @returns {Promise<Object>} Database operation result.
   */
  async function updateSessionGitRoot(id, gitRoot) {
    return s.updateSessionGitRoot.run({ $id: id, $gitRoot: gitRoot ?? null });
  }

  /**
   * Updates the status of a session.
   *
   * @param {string} id - Session identifier.
   * @param {string} status - New status value (e.g., "active", "inactive", "completed").
   * @returns {Promise<Object>} Database operation result.
   */
  async function updateSessionStatus(id, status) {
    return s.updateSessionStatus.run({ $id: id, $status: status });
  }

  /**
   * Updates the last active timestamp of a session to the current time.
   *
   * Used to track session activity and determine which sessions are actively
   * being used.
   *
   * @param {string} id - Session identifier.
   * @returns {Promise<Object>} Database operation result.
   */
  async function touchSessionActive(id) {
    return s.touchSessionActive.run({ $id: id });
  }

  /**
   * Retrieves a session by its identifier.
   *
   * @param {string} id - Session identifier.
   * @returns {Promise<Object|null>} Session object or null if not found.
   */
  async function getSession(id) {
    return s.getSession.get({ $id: id }) ?? null;
  }

  /**
   * Retrieves all currently active sessions.
   *
   * @returns {Promise<Array<Object>>} Array of active session objects.
   */
  async function getActiveSessions() {
    return s.getActiveSessions.all();
  }

  /**
   * Retrieves all sessions regardless of status.
   *
   * @returns {Promise<Array<Object>>} Array of all session objects.
   */
  async function getAllSessions() {
    return s.getAllSessions.all();
  }

  /**
   * Finds an active session by project directory path.
   *
   * @param {string} projectDir - Absolute path to the project directory.
   * @returns {Promise<Object|null>} Active session object or null if not found.
   */
  async function findActiveSessionByDir(projectDir) {
    return s.findActiveSessionByDir.get({ $projectDir: projectDir }) ?? null;
  }

  /**
   * Finds the most recent session for a given project directory.
   *
   * Returns the most recently active session, regardless of current status.
   *
   * @param {string} projectDir - Absolute path to the project directory.
   * @returns {Promise<Object|null>} Most recent session object or null if not found.
   */
  async function findRecentSessionByDir(projectDir) {
    return s.findRecentSessionByDir.get({ $projectDir: projectDir }) ?? null;
  }

  /**
   * Finds an active session by Git repository root path.
   *
   * @param {string} gitRoot - Path to the Git repository root.
   * @returns {Promise<Object|null>} Active session object or null if not found.
   */
  async function findActiveSessionByGitRoot(gitRoot) {
    return s.findActiveSessionByGitRoot.get({ $gitRoot: gitRoot }) ?? null;
  }

  /**
   * Finds the most recent session for a given Git repository.
   *
   * Returns the most recently active session, regardless of current status.
   *
   * @param {string} gitRoot - Path to the Git repository root.
   * @returns {Promise<Object|null>} Most recent session object or null if not found.
   */
  async function findRecentSessionByGitRoot(gitRoot) {
    return s.findRecentSessionByGitRoot.get({ $gitRoot: gitRoot }) ?? null;
  }

  // -------------------------------------------------------------------------
  // Event operations
  // -------------------------------------------------------------------------

  /**
   * Inserts a new event record for tracking actions within a session.
   *
   * Events represent user actions, tool invocations, or system events that
   * occur during a coding session.
   *
   * @param {Object} params - Event parameters.
   * @param {string} params.sessionId - Session identifier this event belongs to.
   * @param {string} params.type - Event type (e.g., "tool_use", "file_edit", "error").
   * @param {string} [params.toolName] - Optional name of the tool that was used.
   * @param {string} [params.filePath] - Optional file path related to this event.
   * @param {string} [params.summary] - Optional human-readable event summary.
   * @param {string} [params.payload] - Optional JSON payload with additional event data.
   * @returns {Promise<Object>} Object containing the newly created event ID.
   */
  async function insertEvent({ sessionId, type, toolName, filePath, summary, payload }) {
    const row = s.insertEvent.get({
      $sessionId: sessionId,
      $type: type,
      $toolName: toolName ?? null,
      $filePath: filePath ?? null,
      $summary: summary ?? null,
      $payload: payload ?? null,
    });
    return { id: row ? Number(row.id) : null };
  }

  /**
   * Convenience wrapper that inserts an event and returns only the ID.
   *
   * @param {Object} params - Event parameters (same as insertEvent).
   * @returns {Promise<number|null>} The newly created event ID or null.
   */
  async function insertEventRow(params) {
    const { id } = await insertEvent(params);
    return id;
  }

  /**
   * Retrieves a single event by its identifier.
   *
   * @param {string|number} id - Event identifier.
   * @returns {Promise<Object|null>} Event object or null if not found.
   */
  async function getEvent(id) {
    return s.getEvent.get({ $id: id }) ?? null;
  }

  /**
   * Retrieves all events for a given session.
   *
   * @param {string} sessionId - Session identifier.
   * @returns {Promise<Array<Object>>} Array of event objects ordered by timestamp.
   */
  async function getSessionEvents(sessionId) {
    return s.getSessionEvents.all({ $sessionId: sessionId });
  }

  /**
   * Retrieves recent events across all sessions with full details.
   *
   * Typically used for dashboard displays and activity monitoring.
   *
   * @returns {Promise<Array<Object>>} Array of recent event objects with complete data.
   */
  async function getRecentEvents() {
    return s.getRecentEvents.all();
  }

  /**
   * Retrieves recent events with minimal fields for performance.
   *
   * Returns a lightweight version of events suitable for list views and
   * performance-sensitive contexts.
   *
   * @returns {Promise<Array<Object>>} Array of recent event objects with reduced fields.
   */
  async function getRecentEventsSlim() {
    return s.getRecentEventsSlim.all();
  }

  // -------------------------------------------------------------------------
  // Session alias operations
  // -------------------------------------------------------------------------

  /**
   * Retrieves a dashboard session ID mapped to a Claude session ID.
   *
   * Session aliases allow mapping between external Claude session identifiers
   * and internal dashboard session identifiers.
   *
   * @param {string} claudeSessionId - Claude session identifier.
   * @returns {Promise<Object|null>} Alias record or null if not found.
   */
  async function getAlias(claudeSessionId) {
    return s.getAlias.get({ $claudeSessionId: claudeSessionId }) ?? null;
  }

  /**
   * Creates a mapping between a Claude session ID and a dashboard session ID.
   *
   * @param {string} claudeSessionId - Claude session identifier.
   * @param {string} dashboardSessionId - Internal dashboard session identifier.
   * @returns {Promise<Object>} Database operation result.
   */
  async function insertAlias(claudeSessionId, dashboardSessionId) {
    return s.insertAlias.run({
      $claudeSessionId: claudeSessionId,
      $dashboardSessionId: dashboardSessionId,
    });
  }

  // -------------------------------------------------------------------------
  // Agent (sub-agent) tracking
  // -------------------------------------------------------------------------

  /**
   * Creates a record for a sub-agent execution within a session.
   *
   * Agents represent autonomous sub-tasks spawned during a session, such as
   * code exploration agents, build validators, or test runners.
   *
   * @param {Object} params - Agent parameters.
   * @param {string} params.sessionId - Session identifier this agent belongs to.
   * @param {string|number} [params.eventId] - Optional event ID that triggered this agent.
   * @param {string} [params.description] - Optional short description of the agent's task.
   * @param {string} [params.agentType] - Optional type of agent (e.g., "explore", "plan", "test").
   * @param {string} [params.prompt] - Optional prompt text given to the agent.
   * @param {string} [params.status="completed"] - Agent execution status.
   * @returns {Promise<Object|null>} The newly created agent record or null.
   */
  async function insertAgent({ sessionId, eventId, description, agentType, prompt, status }) {
    const row = s.insertAgent.get({
      $sessionId: sessionId,
      $eventId: eventId ?? null,
      $description: description ?? null,
      $agentType: agentType ?? null,
      $prompt: prompt ?? null,
      $status: status ?? "completed",
    });
    return row ?? null;
  }

  /**
   * Retrieves all agent records for a given session.
   *
   * @param {string} sessionId - Session identifier.
   * @returns {Promise<Array<Object>>} Array of agent objects.
   */
  async function getSessionAgents(sessionId) {
    return s.getSessionAgents.all({ $sessionId: sessionId });
  }

  /**
   * Counts the number of agents executed within a session.
   *
   * @param {string} sessionId - Session identifier.
   * @returns {Promise<Object>} Object containing the count.
   */
  async function getSessionAgentCount(sessionId) {
    return s.getSessionAgentCount.get({ $sessionId: sessionId });
  }

  /**
   * Retrieves recent agent executions across all sessions with full details.
   *
   * @returns {Promise<Array<Object>>} Array of recent agent objects with complete data.
   */
  async function getRecentAgents() {
    return s.getRecentAgents.all();
  }

  /**
   * Retrieves recent agent executions with minimal fields for performance.
   *
   * @returns {Promise<Array<Object>>} Array of recent agent objects with reduced fields.
   */
  async function getRecentAgentsSlim() {
    return s.getRecentAgentsSlim.all();
  }

  // -------------------------------------------------------------------------
  // Worktree (PR-like review) tracking
  // -------------------------------------------------------------------------

  /**
   * Retrieves a worktree record by its identifier.
   *
   * Worktrees represent Git worktree directories used for PR-like code review
   * workflows, allowing isolated work on separate branches.
   *
   * @param {string|number} id - Worktree identifier.
   * @returns {Promise<Object|null>} Worktree object or null if not found.
   */
  async function getWorktree(id) {
    return s.getWorktree.get({ $id: id }) ?? null;
  }

  /**
   * Finds a worktree by session and branch name.
   *
   * @param {string} sessionId - Session identifier.
   * @param {string} branchName - Git branch name.
   * @returns {Promise<Object|null>} Worktree object or null if not found.
   */
  async function getWorktreeByBranch(sessionId, branchName) {
    return s.getWorktreeByBranch.get({ $sessionId: sessionId, $branchName: branchName }) ?? null;
  }

  /**
   * Retrieves all worktrees associated with a session.
   *
   * @param {string} sessionId - Session identifier.
   * @returns {Promise<Array<Object>>} Array of worktree objects.
   */
  async function getSessionWorktrees(sessionId) {
    return s.getSessionWorktrees.all({ $sessionId: sessionId });
  }

  /**
   * Retrieves all active worktrees across all sessions.
   *
   * @returns {Promise<Array<Object>>} Array of active worktree objects.
   */
  async function getAllActiveWorktrees() {
    return s.getAllActiveWorktrees.all();
  }

  /**
   * Creates a new worktree record.
   *
   * @param {Object} params - Worktree parameters.
   * @param {string} params.sessionId - Session identifier this worktree belongs to.
   * @param {string} params.branchName - Git branch name for this worktree.
   * @param {string} [params.baseBranch="main"] - Base branch to compare against.
   * @param {string} [params.description] - Optional description of the changes.
   * @param {string|number} [params.agentId] - Optional agent ID that created this worktree.
   * @param {string} [params.status="pending"] - Worktree status.
   * @returns {Promise<Object|null>} The newly created worktree record or null.
   */
  async function insertWorktree({ sessionId, branchName, baseBranch, description, agentId, status }) {
    const row = s.insertWorktree.get({
      $sessionId: sessionId,
      $branchName: branchName,
      $baseBranch: baseBranch ?? "main",
      $description: description ?? null,
      $agentId: agentId ?? null,
      $status: status ?? "pending",
    });
    return row ?? null;
  }

  /**
   * Updates diff statistics for a worktree.
   *
   * Records information about file changes, insertions, and deletions.
   *
   * @param {string|number} id - Worktree identifier.
   * @param {Object} params - Statistics parameters.
   * @param {number} [params.filesChanged=0] - Number of files changed.
   * @param {number} [params.insertions=0] - Number of lines inserted.
   * @param {number} [params.deletions=0] - Number of lines deleted.
   * @param {string} [params.diffStat] - Optional diff stat summary string.
   * @param {string} params.status - Updated status value.
   * @returns {Promise<Object>} Database operation result.
   */
  async function updateWorktreeStats(id, { filesChanged, insertions, deletions, diffStat, status }) {
    return s.updateWorktreeStats.run({
      $id: id,
      $filesChanged: filesChanged ?? 0,
      $insertions: insertions ?? 0,
      $deletions: deletions ?? 0,
      $diffStat: diffStat ?? null,
      $status: status,
    });
  }

  /**
   * Updates the status of a worktree.
   *
   * @param {string|number} id - Worktree identifier.
   * @param {string} status - New status value (e.g., "pending", "reviewing", "merged").
   * @returns {Promise<Object>} Database operation result.
   */
  async function updateWorktreeStatus(id, status) {
    return s.updateWorktreeStatus.run({ $id: id, $status: status });
  }

  /**
   * Updates merge conflict information for a worktree.
   *
   * @param {string|number} id - Worktree identifier.
   * @param {string} conflictInfo - JSON string or text describing conflicts.
   * @returns {Promise<Object>} Database operation result.
   */
  async function updateWorktreeConflicts(id, conflictInfo) {
    return s.updateWorktreeConflicts.run({ $id: id, $conflictInfo: conflictInfo ?? null });
  }

  /**
   * Deletes a worktree record from the database.
   *
   * @param {string|number} id - Worktree identifier.
   * @returns {Promise<Object>} Database operation result.
   */
  async function deleteWorktreeRow(id) {
    return s.deleteWorktreeRow.run({ $id: id });
  }

  // -------------------------------------------------------------------------
  // Crafting workbench — agents
  // -------------------------------------------------------------------------

  /**
   * Retrieves all custom craft agents defined by the user.
   *
   * Craft agents are user-defined AI agent templates with custom prompts,
   * icons, and behaviors for specialized tasks.
   *
   * @returns {Promise<Array<Object>>} Array of all craft agent objects.
   */
  async function getAllCraftAgents() {
    return s.getAllCraftAgents.all();
  }

  /**
   * Retrieves a single craft agent by its identifier.
   *
   * @param {string|number} id - Craft agent identifier.
   * @returns {Promise<Object|null>} Craft agent object or null if not found.
   */
  async function getCraftAgent(id) {
    return s.getCraftAgent.get({ $id: id }) ?? null;
  }

  /**
   * Creates a new custom craft agent.
   *
   * @param {Object} params - Craft agent parameters.
   * @param {string} params.name - Display name for the agent.
   * @param {string} [params.description] - Optional description of the agent's purpose.
   * @param {string} params.promptSnippet - The prompt template/snippet for this agent.
   * @param {string} [params.icon="default"] - Icon identifier or emoji.
   * @param {string} [params.color="#4ade80"] - Hex color code for visual identification.
   * @param {string} [params.tags="[]"] - JSON array of tag strings for categorization.
   * @param {string} [params.modelPreference] - Optional preferred AI model for this agent.
   * @returns {Promise<Object>} The newly created craft agent record.
   */
  async function insertCraftAgent({ name, description, promptSnippet, icon, color, tags, modelPreference }) {
    return s.insertCraftAgent.get({
      $name: name,
      $description: description ?? null,
      $promptSnippet: promptSnippet,
      $icon: icon ?? "default",
      $color: color ?? "#4ade80",
      $tags: tags ?? "[]",
      $modelPreference: modelPreference ?? null,
    });
  }

  /**
   * Updates an existing craft agent.
   *
   * @param {string|number} id - Craft agent identifier.
   * @param {Object} params - Updated agent parameters (same as insertCraftAgent).
   * @returns {Promise<Object>} The updated craft agent record.
   */
  async function updateCraftAgent(id, { name, description, promptSnippet, icon, color, tags, modelPreference }) {
    return s.updateCraftAgentStmt.get({
      $id: id,
      $name: name,
      $description: description ?? null,
      $promptSnippet: promptSnippet,
      $icon: icon ?? "default",
      $color: color ?? "#4ade80",
      $tags: tags ?? "[]",
      $modelPreference: modelPreference ?? null,
    });
  }

  /**
   * Deletes a craft agent from the database.
   *
   * @param {string|number} id - Craft agent identifier.
   * @returns {Promise<Object>} Database operation result.
   */
  async function deleteCraftAgent(id) {
    return s.deleteCraftAgentStmt.run({ $id: id });
  }

  // -------------------------------------------------------------------------
  // Crafting workbench — recipes
  // -------------------------------------------------------------------------

  /**
   * Retrieves all custom craft recipes defined by the user.
   *
   * Craft recipes are combinations of multiple agents (ingredients) that work
   * together to accomplish complex tasks.
   *
   * @returns {Promise<Array<Object>>} Array of all craft recipe objects.
   */
  async function getAllCraftRecipes() {
    return s.getAllCraftRecipes.all();
  }

  /**
   * Retrieves a single craft recipe by its identifier.
   *
   * @param {string|number} id - Craft recipe identifier.
   * @returns {Promise<Object|null>} Craft recipe object or null if not found.
   */
  async function getCraftRecipe(id) {
    return s.getCraftRecipe.get({ $id: id }) ?? null;
  }

  /**
   * Creates a new custom craft recipe.
   *
   * @param {Object} params - Craft recipe parameters.
   * @param {string} params.name - Display name for the recipe.
   * @param {string} [params.description] - Optional description of the recipe's purpose.
   * @param {string} [params.synthesizedPrompt] - Optional combined prompt from all ingredients.
   * @param {string} [params.ingredientIds="[]"] - JSON array of craft agent IDs that compose this recipe.
   * @param {string} [params.icon="#fbbf24"] - Icon identifier or emoji.
   * @param {string} [params.color="#fbbf24"] - Hex color code for visual identification.
   * @param {string} [params.tags="[]"] - JSON array of tag strings for categorization.
   * @param {string} [params.modelPreference] - Optional preferred AI model for this recipe.
   * @returns {Promise<Object>} The newly created craft recipe record.
   */
  async function insertCraftRecipe({ name, description, synthesizedPrompt, ingredientIds, icon, color, tags, modelPreference }) {
    return s.insertCraftRecipe.get({
      $name: name,
      $description: description ?? null,
      $synthesizedPrompt: synthesizedPrompt ?? null,
      $ingredientIds: ingredientIds ?? "[]",
      $icon: icon ?? "#fbbf24",
      $color: color ?? "#fbbf24",
      $tags: tags ?? "[]",
      $modelPreference: modelPreference ?? null,
    });
  }

  /**
   * Updates an existing craft recipe.
   *
   * @param {string|number} id - Craft recipe identifier.
   * @param {Object} params - Updated recipe parameters (same as insertCraftRecipe).
   * @returns {Promise<Object>} The updated craft recipe record.
   */
  async function updateCraftRecipe(id, { name, description, synthesizedPrompt, ingredientIds, icon, color, tags, modelPreference }) {
    return s.updateCraftRecipeStmt.get({
      $id: id,
      $name: name,
      $description: description ?? null,
      $synthesizedPrompt: synthesizedPrompt ?? null,
      $ingredientIds: ingredientIds ?? "[]",
      $icon: icon ?? "#fbbf24",
      $color: color ?? "#fbbf24",
      $tags: tags ?? "[]",
      $modelPreference: modelPreference ?? null,
    });
  }

  /**
   * Deletes a craft recipe from the database.
   *
   * @param {string|number} id - Craft recipe identifier.
   * @returns {Promise<Object>} Database operation result.
   */
  async function deleteCraftRecipe(id) {
    return s.deleteCraftRecipeStmt.run({ $id: id });
  }

  // -------------------------------------------------------------------------
  // Conversation history (Agent SDK)
  // -------------------------------------------------------------------------

  /**
   * Retrieves a conversation record by its identifier.
   *
   * Conversations store the message history and context for AI agent interactions
   * using the Agent SDK.
   *
   * @param {string} id - Conversation identifier.
   * @returns {Promise<Object|null>} Conversation object or null if not found.
   */
  async function getConversation(id) {
    return s.getConversationStmt.get({ $id: id }) ?? null;
  }

  /**
   * Creates or updates a conversation record.
   *
   * @param {Object} params - Conversation parameters.
   * @param {string} params.id - Unique conversation identifier.
   * @param {Array<Object>} params.messages - Array of message objects in the conversation.
   * @param {string} [params.systemPrompt] - Optional system prompt for the conversation.
   * @param {string} [params.model] - Optional AI model identifier.
   * @param {number} [params.totalTokens=0] - Optional total token count.
   * @returns {Promise<Object>} Database operation result.
   */
  async function upsertConversation({ id, messages, systemPrompt, model, totalTokens }) {
    return s.upsertConversationStmt.run({
      $id: id,
      $messages: JSON.stringify(messages),
      $systemPrompt: systemPrompt ?? null,
      $model: model ?? null,
      $totalTokens: totalTokens ?? 0,
    });
  }

  /**
   * Appends new messages to an existing conversation.
   *
   * Retrieves the current messages, appends the new ones, and updates the record.
   * If the conversation doesn't exist, this function returns early without error.
   *
   * @param {string} id - Conversation identifier.
   * @param {Array<Object>} newMessages - Array of new message objects to append.
   * @returns {Promise<void>}
   */
  async function appendMessages(id, newMessages) {
    const row = s.getConversationStmt.get({ $id: id });
    if (!row) return;
    const existing = JSON.parse(row.messages || "[]");
    existing.push(...newMessages);
    s.upsertConversationStmt.run({
      $id: id,
      $messages: JSON.stringify(existing),
      $systemPrompt: null,
      $model: null,
      $totalTokens: null,
    });
  }

  /**
   * Deletes a conversation from the database.
   *
   * @param {string} id - Conversation identifier.
   * @returns {Promise<Object>} Database operation result.
   */
  async function deleteConversation(id) {
    return s.deleteConversationStmt.run({ $id: id });
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  /**
   * Retrieves all global application settings.
   *
   * Settings are stored as key-value pairs and can optionally be encrypted.
   *
   * @returns {Promise<Array<Object>>} Array of all setting objects.
   */
  async function getAllSettings() {
    return s.getAllSettingsStmt.all();
  }

  /**
   * Retrieves a single setting by its key.
   *
   * @param {string} key - Setting key identifier.
   * @returns {Promise<Object|null>} Setting object or null if not found.
   */
  async function getSetting(key) {
    return s.getSettingStmt.get({ $key: key }) ?? null;
  }

  /**
   * Creates or updates a global setting.
   *
   * @param {string} key - Setting key identifier.
   * @param {string} value - Setting value.
   * @param {boolean} [encrypted=false] - Whether the value should be encrypted.
   * @returns {Promise<Object>} Database operation result.
   */
  async function upsertSetting(key, value, encrypted = false) {
    return s.upsertSettingStmt.run({ $key: key, $value: value, $encrypted: encrypted ? 1 : 0 });
  }

  /**
   * Deletes a setting from the database.
   *
   * @param {string} key - Setting key identifier.
   * @returns {Promise<Object>} Database operation result.
   */
  async function deleteSetting(key) {
    return s.deleteSettingStmt.run({ $key: key });
  }

  // -------------------------------------------------------------------------
  // Users & auth
  // -------------------------------------------------------------------------

  /**
   * Retrieves a user by their internal user ID.
   *
   * @param {string} id - Internal user identifier.
   * @returns {Promise<Object|null>} User object or null if not found.
   */
  async function getUserById(id) {
    return s.getUserByIdStmt.get({ $id: id }) ?? null;
  }

  /**
   * Retrieves a user by their Google account ID.
   *
   * Used for OAuth authentication with Google.
   *
   * @param {string} googleId - Google account identifier.
   * @returns {Promise<Object|null>} User object or null if not found.
   */
  async function getUserByGoogleId(googleId) {
    return s.getUserByGoogleIdStmt.get({ $googleId: googleId }) ?? null;
  }

  /**
   * Retrieves a user by their API key.
   *
   * Used for API authentication.
   *
   * @param {string} apiKey - User's API key.
   * @returns {Promise<Object|null>} User object or null if not found.
   */
  async function getUserByApiKey(apiKey) {
    return s.getUserByApiKeyStmt.get({ $apiKey: apiKey }) ?? null;
  }

  /**
   * Creates or updates a user record.
   *
   * @param {Object} params - User parameters.
   * @param {string} params.id - Unique user identifier.
   * @param {string} params.googleId - Google account identifier.
   * @param {string} params.email - User's email address.
   * @param {string} [params.name] - Optional user's display name.
   * @param {string} [params.avatarUrl] - Optional URL to user's avatar image.
   * @param {string} params.apiKey - User's API key for authentication.
   * @returns {Promise<Object>} The created or updated user record.
   */
  async function upsertUser({ id, googleId, email, name, avatarUrl, apiKey }) {
    return s.upsertUserStmt.get({
      $id: id,
      $googleId: googleId,
      $email: email,
      $name: name ?? null,
      $avatarUrl: avatarUrl ?? null,
      $apiKey: apiKey,
    });
  }

  /**
   * Updates a user's API key.
   *
   * @param {string} id - User identifier.
   * @param {string} newApiKey - New API key value.
   * @returns {Promise<Object|null>} Updated user record or null.
   */
  async function updateUserApiKey(id, newApiKey) {
    return s.updateUserApiKeyStmt.get({ $id: id, $apiKey: newApiKey }) ?? null;
  }

  /**
   * Retrieves all sessions belonging to a specific user.
   *
   * @param {string} userId - User identifier.
   * @returns {Promise<Array<Object>>} Array of session objects for the user.
   */
  async function getAllSessionsByUser(userId) {
    return s.getAllSessionsByUser.all({ $userId: userId });
  }

  /**
   * Retrieves recent events for a specific user with full details.
   *
   * @param {string} userId - User identifier.
   * @returns {Promise<Array<Object>>} Array of recent event objects for the user.
   */
  async function getRecentEventsByUser(userId) {
    return s.getRecentEventsByUser.all({ $userId: userId });
  }

  /**
   * Retrieves recent events for a specific user with minimal fields.
   *
   * @param {string} userId - User identifier.
   * @returns {Promise<Array<Object>>} Array of recent event objects with reduced fields.
   */
  async function getRecentEventsSlimByUser(userId) {
    return s.getRecentEventsSlimByUser.all({ $userId: userId });
  }

  // -------------------------------------------------------------------------
  // User settings
  // -------------------------------------------------------------------------

  /**
   * Retrieves all settings for a specific user.
   *
   * User settings are scoped to individual users, unlike global settings.
   *
   * @param {string} userId - User identifier.
   * @returns {Promise<Array<Object>>} Array of setting objects for the user.
   */
  async function getUserSettings(userId) {
    return s.getUserSettingsStmt.all({ $userId: userId });
  }

  /**
   * Retrieves a single user setting by user ID and key.
   *
   * @param {string} userId - User identifier.
   * @param {string} key - Setting key identifier.
   * @returns {Promise<Object|null>} Setting object or null if not found.
   */
  async function getUserSetting(userId, key) {
    return s.getUserSettingStmt.get({ $userId: userId, $key: key }) ?? null;
  }

  /**
   * Creates or updates a user-specific setting.
   *
   * @param {Object} params - User setting parameters.
   * @param {string} params.userId - User identifier.
   * @param {string} params.key - Setting key identifier.
   * @param {string} params.value - Setting value.
   * @param {boolean} params.encrypted - Whether the value should be encrypted.
   * @returns {Promise<Object>} Database operation result.
   */
  async function upsertUserSetting({ userId, key, value, encrypted }) {
    return s.upsertUserSettingStmt.run({
      $userId: userId,
      $key: key,
      $value: value,
      $encrypted: encrypted ? 1 : 0,
    });
  }

  /**
   * Deletes a user-specific setting.
   *
   * @param {string} userId - User identifier.
   * @param {string} key - Setting key identifier.
   * @returns {Promise<Object>} Database operation result.
   */
  async function deleteUserSetting(userId, key) {
    return s.deleteUserSettingStmt.run({ $userId: userId, $key: key });
  }

  // -------------------------------------------------------------------------
  // Maintenance / cleanup
  // -------------------------------------------------------------------------

  /**
   * Deletes a session and all its associated data.
   *
   * This typically includes related events, agents, and other dependent records,
   * depending on the underlying database schema constraints.
   *
   * @param {string} sessionId - Session identifier to delete.
   * @returns {Promise<Object>} Database operation result.
   */
  async function deleteSession(sessionId) {
    return s.deleteSession(sessionId);
  }

  /**
   * Removes duplicate session records based on project directory.
   *
   * Identifies and removes duplicate sessions that point to the same project
   * directory, keeping the most recent one.
   *
   * @returns {Promise<Object>} Database operation result with count of removed duplicates.
   */
  async function deduplicateSessions() {
    return s.deduplicateSessions();
  }

  /**
   * Reconciles orphaned sessions that have missing or invalid references.
   *
   * Identifies sessions with broken references and either fixes or removes them
   * to maintain database integrity.
   *
   * @returns {Promise<Object>} Database operation result with count of reconciled sessions.
   */
  async function reconcileOrphanedSessions() {
    return s.reconcileOrphanedSessions();
  }

  /**
   * Prunes old data from the database based on retention policies.
   *
   * Removes old events, inactive sessions, and other stale data to keep the
   * database size manageable.
   *
   * @returns {Promise<Object>} Database operation result with counts of pruned records.
   */
  async function pruneOldData() {
    return s.pruneOldData();
  }

  _impl = {
    sql: null,
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
    getConversation,
    upsertConversation,
    appendMessages,
    deleteConversation,
    getAllSettings,
    getSetting,
    upsertSetting,
    deleteSetting,
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
  };
}

// ---------------------------------------------------------------------------
// Named exports — destructure from _impl so callers get static named imports.
// ---------------------------------------------------------------------------

export const {
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
  getConversation,
  upsertConversation,
  appendMessages,
  deleteConversation,
  getAllSettings,
  getSetting,
  upsertSetting,
  deleteSetting,
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
} = _impl;
