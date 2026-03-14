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

  // The Supabase runInTransaction passes a `tx` tagged-template sql object to
  // fn.  In SQLite mode we run fn(null); the individual helper functions below
  // do not accept a tx argument, so passing null is safe.
  async function runInTransaction(fn) {
    return fn(null);
  }

  // -------------------------------------------------------------------------
  // Session operations
  // -------------------------------------------------------------------------

  async function upsertSession({ id, projectDir, worktreeDir, gitRoot, status, model, currentClaudeSessionId }) {
    return s.upsertSession.run({
      $id: id,
      $projectDir: projectDir,
      $worktreeDir: worktreeDir ?? null,
      $gitRoot: gitRoot ?? null,
      $status: status,
      $model: model ?? null,
      $currentClaudeSessionId: currentClaudeSessionId ?? null,
    });
  }

  async function updateSessionGitRoot(id, gitRoot) {
    return s.updateSessionGitRoot.run({ $id: id, $gitRoot: gitRoot ?? null });
  }

  async function updateSessionStatus(id, status) {
    return s.updateSessionStatus.run({ $id: id, $status: status });
  }

  async function touchSessionActive(id) {
    return s.touchSessionActive.run({ $id: id });
  }

  async function getSession(id) {
    return s.getSession.get({ $id: id }) ?? null;
  }

  async function getActiveSessions() {
    return s.getActiveSessions.all();
  }

  async function getAllSessions() {
    return s.getAllSessions.all();
  }

  async function findActiveSessionByDir(projectDir) {
    return s.findActiveSessionByDir.get({ $projectDir: projectDir }) ?? null;
  }

  async function findRecentSessionByDir(projectDir) {
    return s.findRecentSessionByDir.get({ $projectDir: projectDir }) ?? null;
  }

  async function findActiveSessionByGitRoot(gitRoot) {
    return s.findActiveSessionByGitRoot.get({ $gitRoot: gitRoot }) ?? null;
  }

  async function findRecentSessionByGitRoot(gitRoot) {
    return s.findRecentSessionByGitRoot.get({ $gitRoot: gitRoot }) ?? null;
  }

  // -------------------------------------------------------------------------
  // Event operations
  // -------------------------------------------------------------------------

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

  async function insertEventRow(params) {
    const { id } = await insertEvent(params);
    return id;
  }

  async function getEvent(id) {
    return s.getEvent.get({ $id: id }) ?? null;
  }

  async function getSessionEvents(sessionId) {
    return s.getSessionEvents.all({ $sessionId: sessionId });
  }

  async function getRecentEvents() {
    return s.getRecentEvents.all();
  }

  async function getRecentEventsSlim() {
    return s.getRecentEventsSlim.all();
  }

  // -------------------------------------------------------------------------
  // Session alias operations
  // -------------------------------------------------------------------------

  async function getAlias(claudeSessionId) {
    return s.getAlias.get({ $claudeSessionId: claudeSessionId }) ?? null;
  }

  async function insertAlias(claudeSessionId, dashboardSessionId) {
    return s.insertAlias.run({
      $claudeSessionId: claudeSessionId,
      $dashboardSessionId: dashboardSessionId,
    });
  }

  // -------------------------------------------------------------------------
  // Agent (sub-agent) tracking
  // -------------------------------------------------------------------------

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

  async function getSessionAgents(sessionId) {
    return s.getSessionAgents.all({ $sessionId: sessionId });
  }

  async function getSessionAgentCount(sessionId) {
    return s.getSessionAgentCount.get({ $sessionId: sessionId });
  }

  async function getRecentAgents() {
    return s.getRecentAgents.all();
  }

  async function getRecentAgentsSlim() {
    return s.getRecentAgentsSlim.all();
  }

  // -------------------------------------------------------------------------
  // Worktree (PR-like review) tracking
  // -------------------------------------------------------------------------

  async function getWorktree(id) {
    return s.getWorktree.get({ $id: id }) ?? null;
  }

  async function getWorktreeByBranch(sessionId, branchName) {
    return s.getWorktreeByBranch.get({ $sessionId: sessionId, $branchName: branchName }) ?? null;
  }

  async function getSessionWorktrees(sessionId) {
    return s.getSessionWorktrees.all({ $sessionId: sessionId });
  }

  async function getAllActiveWorktrees() {
    return s.getAllActiveWorktrees.all();
  }

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

  async function updateWorktreeStatus(id, status) {
    return s.updateWorktreeStatus.run({ $id: id, $status: status });
  }

  async function updateWorktreeConflicts(id, conflictInfo) {
    return s.updateWorktreeConflicts.run({ $id: id, $conflictInfo: conflictInfo ?? null });
  }

  async function deleteWorktreeRow(id) {
    return s.deleteWorktreeRow.run({ $id: id });
  }

  // -------------------------------------------------------------------------
  // Crafting workbench — agents
  // -------------------------------------------------------------------------

  async function getAllCraftAgents() {
    return s.getAllCraftAgents.all();
  }

  async function getCraftAgent(id) {
    return s.getCraftAgent.get({ $id: id }) ?? null;
  }

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

  async function deleteCraftAgent(id) {
    return s.deleteCraftAgentStmt.run({ $id: id });
  }

  // -------------------------------------------------------------------------
  // Crafting workbench — recipes
  // -------------------------------------------------------------------------

  async function getAllCraftRecipes() {
    return s.getAllCraftRecipes.all();
  }

  async function getCraftRecipe(id) {
    return s.getCraftRecipe.get({ $id: id }) ?? null;
  }

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

  async function deleteCraftRecipe(id) {
    return s.deleteCraftRecipeStmt.run({ $id: id });
  }

  // -------------------------------------------------------------------------
  // Conversation history (Agent SDK)
  // -------------------------------------------------------------------------

  async function getConversation(id) {
    return s.getConversationStmt.get({ $id: id }) ?? null;
  }

  async function upsertConversation({ id, messages, systemPrompt, model, totalTokens }) {
    return s.upsertConversationStmt.run({
      $id: id,
      $messages: JSON.stringify(messages),
      $systemPrompt: systemPrompt ?? null,
      $model: model ?? null,
      $totalTokens: totalTokens ?? 0,
    });
  }

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

  async function deleteConversation(id) {
    return s.deleteConversationStmt.run({ $id: id });
  }

  // -------------------------------------------------------------------------
  // Maintenance / cleanup
  // -------------------------------------------------------------------------

  async function deleteSession(sessionId) {
    return s.deleteSession(sessionId);
  }

  async function deduplicateSessions() {
    return s.deduplicateSessions();
  }

  async function reconcileOrphanedSessions() {
    return s.reconcileOrphanedSessions();
  }

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
} = _impl;
