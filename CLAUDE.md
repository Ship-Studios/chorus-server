# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this package.

See also the [root CLAUDE.md](../../CLAUDE.md) for full project architecture, REST API docs, DB schema, and WebSocket protocol.

## Commands

```bash
# Dev server with hot reload
bun --watch src/index.js

# Run all tests (~21 files)
bun test src

# Run a single test file
bun test src/api.test.js
bun test src/routes-crafting.test.js

# Run diff-summary evals (calls real Anthropic API -- NOT part of normal CI)
ANTHROPIC_API_KEY=sk-... bun run eval:diff-summary
```

## Package Overview

Fastify 5 server -- plain JS (ESM, no build step), `bun:sqlite` or Supabase/PostgreSQL for persistence, Socket.IO for real-time broadcast. Entry point: `src/index.js`. No TypeScript, no transpilation. Runs directly on Bun runtime.

## Module Responsibilities

### Core infrastructure

| File | Role |
|------|------|
| `index.js` | Fastify app bootstrap: CORS, helmet, compression, ETags, rate limiting, route plugin registration, API key auth middleware, `/api/health` + `/api/vpn/reconfigure` utility endpoints, production static file serving (`packages/ui/build/`), custom empty-body JSON parser, orphan reconciliation, data retention pruning, VPN detection, Socket.IO init after `app.ready()` (50-client cap, 30s ping interval, room management via `join-session`/`leave-session` events) |
| `socket.js` | Socket.IO singleton: `setIO(server)` called once from `index.js` after `app.ready()`; `getIO()` used by `broadcast.js` and any module that needs to emit. Returns `null` until initialized. |
| `broadcast.js` | `broadcast(msg)` -- global emit via `io.emit("message", msg)`. `broadcastToSession(sessionId, msg)` -- scoped emit via `io.to("session:"+id).emit("message", msg)`. `debouncedDiffInvalidation(sessionId, changedFiles?)` -- 300ms trailing-edge debounce, coalesces burst writes per session. Both broadcast functions also call `invalidateDiffCache()` on `diff:invalidated` messages. |
| `db-adapter.js` | Backend selector: auto-picks Supabase/PostgreSQL (`db-supabase.js`) when `SUPABASE_DB_URL` is set, otherwise wraps SQLite (`db.js`) in async functions. All route files import from here -- never import `db.js` or `db-supabase.js` directly. |
| `db.js` | SQLite schema creation (8 tables, WAL + FK + `mmap_size` + `cache_size` tuning), all prepared statements, `deleteSession()` cascade transaction, `deduplicateSessions()` startup dedup, `reconcileOrphanedSessions()`, `pruneOldData()`, `runInTransaction()` helper. |
| `db-supabase.js` | Supabase/PostgreSQL async DB layer. Same function signatures as the SQLite adapter shim in `db-adapter.js`. |
| `db-pg.js` | Lower-level postgres.js helpers (connection pool, query helpers) used by `db-supabase.js`. |
| `db-pg-extended.js` | Additional PostgreSQL queries (crafting tables, settings) for the Supabase path. |
| `dashboard-snapshot.js` | Versioned snapshot cache for WebSocket `init` payloads. `getDashboardSnapshot()` builds sessions + recentEvents + agents + worktrees in parallel; coalesces concurrent requests via in-flight promise dedup. `invalidateDashboardSnapshot()` increments version counter, clears cache. |
| `diff-cache.js` | 15s TTL, 50-entry LRU in-memory cache for `GET /api/sessions/:id/diff` responses. Keyed by project directory. Includes in-flight promise dedup. `invalidateDiffCache(dir?)` called by `broadcast.js` on `diff:invalidated`. |

### Session management

| File | Role |
|------|------|
| `session-resolver.js` | `resolveSessionId()` -- 5-step async alias resolution: existing alias -> active dir match -> recent dir match -> git-root match (only when `projectDir === topLevel`) -> new session. `lookupSessionId()` -- read-only fallback. `cachedGitRoot()` -- 200-entry LRU with 5-min TTL and promise dedup. |
| `session-sync.js` | Tracks per-session state for heartbeat throttling and change detection. `clearSessionSyncState(sessionId)` clears cached state on session delete. |

### Prompt and agent execution

| File | Role |
|------|------|
| `prompt-adapter.js` | Re-export barrel -- all route files import prompt symbols from here. Delegates to `prompt-sdk.js`. Preserves stable import paths. |
| `prompt-sdk.js` | `sendPrompt()` -- Agent SDK `query()` with streaming, one active prompt per session (409 on conflict), AbortController cancellation, auto-fallback on expired session. Re-exports worktree functions. |
| `agent-tools.js` | Agent SDK tool definitions -- maps Claude Code tools to bridge-routed MCP tool calls with `projectDir` closure injection. |
| `agent-detector.js` | Extracts agent metadata from `tool_input` when `toolName === "Agent"`. Inserts into `agents` table; truncates prompt to 2000 chars. |

### Git operations

| File | Role |
|------|------|
| `git-worktree.js` | `createWorktree()`, `removeWorktree()` (3-attempt retry), `deleteBranch()`, `getBranchDiffStats()`, `detectConflicts()` via `git merge-tree --write-tree`, `autoCommitWorktree()`, `getCurrentBranch()`, `slugify()`. |
| `git-watcher.js` | chokidar-based git dir watchers. `startWatching(sessionId, dir)` -- watches `.git/HEAD`, `.git/index`, `.git/refs/heads`, `.git/refs/stash` with 300ms debounce. `stopWatching()`, `initWatchers()`, `shutdownWatchers()`. |
| `worktree-discovery.js` | Discovers git worktrees not yet in the DB by parsing `git worktree list --porcelain`. |
| `git.js` | Re-export bridge: `GIT` binary path from `@chorus/diff-panel/server`. |
| `run-git.js` | Re-export bridge: `runGit` from `@chorus/diff-panel/server`. |

### AI and diff utilities

| File | Role |
|------|------|
| `diff.js` | Re-export bridge: `parseDiffToFiles`, `buildStatSummary` from `@chorus/diff-panel/server`. |
| `summarize-diff.js` | Re-export bridge: `summarizeDiff`, `truncateDiff`, `buildUserPrompt`, `SYSTEM_PROMPT`, `DEFAULT_MODEL`, `MAX_DIFF_CHARS` from `@chorus/diff-panel/server`. |
| `commit-git.js` | Low-level git operations for the commit route: preview diff via temp `GIT_INDEX_FILE`, run `git add -A && git commit`, detect dirty submodules. |
| `commit-prompts.js` | Builds the Anthropic prompt for commit message generation (Conventional Commits). |
| `anthropic-error.js` | Normalizes Anthropic SDK errors to human-readable strings for API responses. |
| `vpn.js` | VPN detection + env configuration. `configureVpn()`, `reconfigureVpn()`, `getAnthropicFetchOptions()`, `vpnState` singleton. |

## Route Files

Each exports a default async Fastify plugin registered in `index.js`. Some also export `resetClient()` for VPN reconfiguration.

| File | Endpoints |
|------|-----------|
| `routes/sessions.js` | `POST /api/sessions`, `POST /api/sessions/:id/stop`, `GET /api/sessions`, `DELETE /api/sessions/:id` |
| `routes/events.js` | `POST /api/events`, `POST /api/events/pre-tool`, `POST /api/hooks/pre-tool-use`, `POST /api/hooks/post-tool-use`, `POST /api/hooks/post-tool-use-failure`, `POST /api/hooks/stop`, `GET /api/sessions/:id/events`, `GET /api/events/:id`, `GET /api/events`, `GET /api/sessions/:id/agents` |
| `routes/diff.js` | `GET /api/sessions/:id/diff` (15s cache, in-flight dedup) |
| `routes/diff-summary.js` | `POST /api/sessions/:id/diff/summary`, `GET /api/diff-summary/status`. Exports `resetClient()`. |
| `routes/commit.js` | `POST /api/sessions/:id/commit`. Exports `resetClient()`. |
| `routes/prompt.js` | `POST /api/sessions/:id/prompt` (15MB body limit), `POST /api/sessions/:id/prompt/cancel`, `GET /api/sessions/:id/prompt/status` |
| `routes/worktrees/index.js` | Registers list, diff, and mutation sub-plugins. |
| `routes/worktrees/list.js` | `GET /api/sessions/:id/worktrees` |
| `routes/worktrees/diff.js` | `GET /api/worktrees/:id/diff`, `GET /api/worktrees/:id/files` |
| `routes/worktrees/mutations.js` | `POST /api/worktrees/:id/merge`, `DELETE /api/worktrees/:id`, `POST /api/worktrees/:id/check-conflicts` |
| `routes/crafting.js` | `GET/POST /api/craft/agents`, `PUT/DELETE /api/craft/agents/:id`, `GET/POST /api/craft/recipes`, `PUT/DELETE /api/craft/recipes/:id`, `POST /api/craft/synthesize`, `GET /api/craft/ai-status`. Exports `resetClient()`. |
| `routes/settings.js` | `GET /api/settings`, `PUT /api/settings`, `DELETE /api/settings/:key`, `GET /api/settings/test-anthropic` |
| `routes/directories.js` | `GET /api/directories` |
| `routes/bridge.js` | `/bridge` Socket.IO namespace. `initBridge()`, `executeRemoteTool()`, `isBridgeConnected()`. |

## Testing Approach

21 test files, `bun:test`. Run with `bun test src`.

- **`api.test.js`** -- Integration tests. Builds a minimal Fastify app in-process with in-memory SQLite. Uses `app.inject()`. Schema inlined -- does NOT import `db.js`.
- **`routes-*.test.js`** (9 files) -- Per-route integration tests.
- **`ws-integration.test.js`** -- WebSocket integration tests using a real Socket.IO server.
- **Unit tests** (10 files) -- `db.test.js`, `session-resolver.test.js`, `session-resolver-submodule.test.js`, `broadcast.test.js`, `diff.test.js`, `git.test.js`, `run-git.test.js`, `prompt.test.js`, `git-worktree.test.js`, `summarize-diff.test.js`.
- **`src/evals/diff-summary.eval.js`** -- Calls real Anthropic API. Not run by `bun test`.

### Broadcast test pattern

`broadcast.test.js` uses `setIO()` to inject a mock Socket.IO object, then asserts on captured emit calls. Avoids needing a real Socket.IO server.

## Key Patterns

- **DB backend selection**: `db-adapter.js` switches at startup based on `SUPABASE_DB_URL`. Always import from `db-adapter.js`.
- **Socket.IO singleton**: `socket.js` exports `getIO()`/`setIO()`. `index.js` calls `setIO(io)` once after `app.ready()`. Guards against `null`.
- **Room management**: Clients emit `join-session` / `leave-session`. `broadcastToSession()` emits to `session:<id>` room.
- **SQLite `$param` binding**: Always `$paramName` syntax, never `?` or `:name`.
- **Empty body parser**: Custom `application/json` parser accepts bodyless POSTs (Stop HTTP hook).
- **Re-export bridges**: `prompt-adapter.js` -> `prompt-sdk.js` -> `git-worktree.js`. `db.js` re-exports `session-resolver.js`. Do not change import paths in routes.
- **`resetClient()` exports**: `diff-summary.js`, `commit.js`, `crafting.js` each export `resetClient()`. Called on VPN reconfigure and API key update.
- **Agent SDK backend**: All prompt operations use Agent SDK `query()` in-process. Tool calls route through `/bridge` namespace. No CLI subprocess spawning.
- **Prompt fallback**: `sendPrompt()` retries as fresh `query()` when resume fails. Emits `prompt:context-lost`.
- **Model validation**: `/^[a-zA-Z0-9._/-]+$/` before passing to Agent SDK.
- **CWD validation**: `existsSync(dir)` before spawning git. macOS `posix_spawn` gives misleading ENOENT.
- **Git root LRU**: 200-entry Map, 5-min TTL, promise-deduped. Git I/O runs outside SQLite transactions.
- **Diff response cache**: `diff-cache.js` -- 15s TTL, 50-entry LRU, in-flight dedup. Invalidated on `diff:invalidated`.
- **Diff summary cache**: SHA-256 keyed, 10-min TTL, 100-entry LRU, inflight dedup.
- **`setImmediate` for merges**: Worktree merge replies before running `git merge --no-ff`.
- **Data retention**: `pruneOldData()` at startup + every 24h. `DATA_RETENTION_DAYS` default 30.
- **Orphan reconciliation**: `reconcileOrphanedSessions()` marks stale sessions stopped at startup.
- **API key auth**: `DASHBOARD_API_KEY` enforces Bearer token on `/api/` except health and hook endpoints.
- **Settings priority**: `env var > database > default`. `routes/settings.js` patches `process.env` on PUT.
- **Bridge protocol**: MCP daemons connect to `/bridge` namespace, register project directories, respond to `tool_call` with `tool_result`. 30s timeout per call.
