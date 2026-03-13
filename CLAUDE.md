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

Fastify 5 server — plain JS (ESM, no build step), `bun:sqlite` for persistence, Socket.IO for real-time broadcast. Entry point: `src/index.js`. No TypeScript, no transpilation. Runs directly on Bun runtime.

## Module Responsibilities

| File | Role |
|------|------|
| `index.js` | Fastify app bootstrap: CORS, route plugin registration, `/api/health` + `/api/vpn/reconfigure` utility endpoints, production static file serving (`packages/ui/build/`), custom empty-body JSON parser, VPN detection before listen, Socket.IO init after `app.ready()` (50-client cap, 30s ping interval, room management via `join-session`/`leave-session` events) |
| `socket.js` | Socket.IO singleton: `setIO(server)` called once from `index.js` after `app.ready()`; `getIO()` used by `broadcast.js` and any module that needs to emit. Holds `null` until initialized. |
| `broadcast.js` | `broadcast(msg)` — global emit via `io.emit("message", msg)`. `broadcastToSession(sessionId, msg)` — scoped emit via `io.to("session:"+id).emit("message", msg)`. `debouncedDiffInvalidation(sessionId)` — 300ms trailing-edge debounce, coalesces burst writes per session. `clearDiffTimers()` — shutdown cleanup. |
| `db.js` | Schema creation (7 tables, WAL + FK enforcement), all exported prepared statements, `deleteSession()` cascade transaction, `deduplicateSessions()` startup dedup, `runInTransaction()` helper. Re-exports `resolveSessionId`/`lookupSessionId` from `session-resolver.js`. |
| `session-resolver.js` | `resolveSessionId()` — 5-step alias resolution (existing alias → active dir match → recent dir match → git-root match → new session), runs inside `BEGIN IMMEDIATE` transaction. `lookupSessionId()` — read-only alias lookup, falls back to raw ID. `cachedGitRoot()` — 200-entry insertion-order LRU for `git worktree list --porcelain`; handles submodule detection via `--show-superproject-working-tree`. |
| `prompt.js` | `sendPrompt()` — spawns `claude --resume/--print --output-format stream-json`, one active prompt per session (throws on conflict), SIGTERM→SIGKILL cancel, auto-fallback to fresh session on "no conversation found" (emits `prompt:context-lost`). `cancelPrompt()`, `isPromptActive()`, `getPromptSessionId()`. Re-exports from `swarm-manager.js` and `git-worktree.js` (backward-compat bridges). |
| `swarm-manager.js` | `spawnSwarmAgent()` — fresh `claude --print` process, optional worktree isolation, slot reservation before spawn, auto-commit on exit, diff stats + conflict detection via `git-worktree.js`. `cancelSwarmAgent()` — SIGTERM→SIGKILL + branch/worktree cleanup. `getActiveSwarmAgents()`, `hasActiveSwarmAgents()`. `MAX_SWARM_AGENTS` cap (default 10). |
| `git-worktree.js` | `createWorktree()`, `removeWorktree()` (3-attempt retry + 1.5s delay), `deleteBranch()`, `getBranchDiffStats()`, `detectConflicts()` via `git merge-tree --write-tree`, `getCurrentBranch()`, `slugify()`, `parseWorktreeListPorcelain()`. |
| `stream-parser.js` | `createStreamParser(onChunk)` — line-buffered JSON parser for `claude --output-format stream-json`. Returns `{ feed(data), flush() }`. 512KB safety valve; non-JSON lines emitted as `{ type: "raw", text }`. |
| `git-watcher.js` | chokidar-based git dir watchers. `startWatching(sessionId, dir)` — deduplicates by dir, watches `.git/HEAD`, `.git/index`, `.git/refs/heads`, `.git/refs/stash` with 300ms debounce, calls `debouncedDiffInvalidation`. `stopWatching()`, `initWatchers(sessions)` (called at startup), `shutdownWatchers()`. |
| `architecture.js` | `scanArchitecture()` — async dir walker (max 400 files, depth 8), import-graph parser (ES/CJS/Python/Go), directory tree builder with palette coloring and single-child collapse. `getArchitecture()` wraps with 30s in-memory cache. |
| `vpn.js` | VPN detection + env configuration. `configureVpn()` — startup curl probe to internal endpoint, sets `HTTP_PROXY`/`HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS`/`NO_PROXY`. `reconfigureVpn()` — live re-detection. `getAnthropicFetchOptions()` — Bun-compatible proxy/TLS options for Anthropic SDK. `vpnState` singleton. Supports `FORCE_VPN_MODE`, `FORCE_OFF_VPN`, `VPN_DETECTION_TIMEOUT`, `WALMART_CERT_PATH`. |
| `git.js` | Re-export bridge: `GIT` binary path from `@agent-dashboard/diff-panel/server`. |
| `run-git.js` | Re-export bridge: `runGit` from `@agent-dashboard/diff-panel/server`. |
| `diff.js` | Re-export bridge: `parseDiffToFiles`, `buildStatSummary` from `@agent-dashboard/diff-panel/server`. |
| `summarize-diff.js` | Re-export bridge: `summarizeDiff`, `truncateDiff`, `buildUserPrompt`, `SYSTEM_PROMPT`, `DEFAULT_MODEL`, `MAX_DIFF_CHARS` from `@agent-dashboard/diff-panel/server`. |

## Route Files

Each exports a default async Fastify plugin registered in `index.js`. Some also export `resetClient()` for VPN reconfiguration.

| File | Endpoints |
|------|-----------|
| `routes/sessions.js` | `POST /api/sessions` (heartbeat/register upsert), `POST /api/sessions/:id/stop`, `GET /api/sessions`, `DELETE /api/sessions/:id` |
| `routes/events.js` | `POST /api/events`, `POST /api/events/pre-tool`, `POST /api/hooks/pre-tool-use`, `POST /api/hooks/post-tool-use`, `POST /api/hooks/post-tool-use-failure`, `POST /api/hooks/stop`, `GET /api/sessions/:id/events`, `GET /api/events/:id`, `GET /api/events`, `GET /api/sessions/:id/agents` |
| `routes/diff.js` | `GET /api/sessions/:id/diff` |
| `routes/diff-summary.js` | `POST /api/sessions/:id/diff/summary`, `GET /api/diff-summary/status`. Exports `resetClient()`. |
| `routes/commit.js` | `POST /api/sessions/:id/commit` — AI commit message generation (Conventional Commits) + `git add -A && git commit`. Submodule cascade support. Exports `resetClient()`. |
| `routes/prompt.js` | `POST /api/sessions/:id/prompt` (15MB body limit), `POST /api/sessions/:id/prompt/cancel`, `GET /api/sessions/:id/prompt/status` |
| `routes/swarm.js` | `POST /api/sessions/:id/swarm/spawn` (15MB body limit), `POST /api/swarm/:agentId/cancel`, `GET /api/sessions/:id/swarm` |
| `routes/worktrees/index.js` | Registers list, diff, and mutation sub-plugins. |
| `routes/worktrees/list.js` | `GET /api/sessions/:id/worktrees` (auto-discovers unregistered branches via `git worktree list --porcelain`) |
| `routes/worktrees/diff.js` | `GET /api/worktrees/:id/diff` (three-dot diff, `maxFiles` query param, default 200), `GET /api/worktrees/:id/files` |
| `routes/worktrees/mutations.js` | `POST /api/worktrees/:id/merge`, `DELETE /api/worktrees/:id`, `POST /api/worktrees/:id/check-conflicts` |
| `routes/architecture.js` | `GET /api/sessions/:id/architecture` |
| `routes/crafting.js` | `GET/POST /api/craft/agents`, `PUT/DELETE /api/craft/agents/:id`, `GET/POST /api/craft/recipes`, `PUT/DELETE /api/craft/recipes/:id`, `POST /api/craft/synthesize`, `GET /api/craft/ai-status`. Exports `resetClient()`. |
| `routes/directories.js` | `GET /api/directories` — lists `~/Documents/code` (or `PULSE_ROOT_DIR`) for sidebar navigation |

## Testing Approach

21 test files, `bun:test`. Run with `bun test src`.

- **`api.test.js`** — Integration tests. Builds a minimal Fastify app in-process with an in-memory SQLite DB (schema inlined, does NOT import `db.js` to avoid touching `dashboard.db`). Uses `app.inject()` for HTTP.
- **`routes-*.test.js`** (8 files) — Per-route integration tests: `routes-architecture.test.js`, `routes-commit.test.js`, `routes-crafting.test.js`, `routes-diff-summary.test.js`, `routes-diff.test.js`, `routes-prompt.test.js`, `routes-swarm.test.js`, `routes-worktrees.test.js`.
- **Unit tests** (12 files) — `db.test.js`, `session-resolver.test.js`, `session-resolver-submodule.test.js`, `broadcast.test.js`, `diff.test.js`, `git.test.js`, `run-git.test.js`, `prompt.test.js`, `git-worktree.test.js`, `stream-parser.test.js`, `summarize-diff.test.js`, `architecture.test.js`.
- **`src/evals/diff-summary.eval.js`** — Calls real Anthropic API. Not run by `bun test`. Execute with `ANTHROPIC_API_KEY=sk-... bun run eval:diff-summary`.

### Broadcast test pattern

`broadcast.test.js` uses `setIO()` to inject a mock Socket.IO object with captured `emit` and `to().emit` calls, then asserts on the recorded call list. This pattern avoids needing a real Socket.IO server in tests.

## Key Patterns

- **Socket.IO singleton**: `socket.js` exports `getIO()`/`setIO()`. `index.js` calls `setIO(io)` once after `app.ready()`. All broadcast code calls `getIO()` and guards against `null` (returns early before Socket.IO is ready). Tests inject a mock via `setIO()`.
- **Room management**: Clients emit `join-session` / `leave-session` to subscribe to session-scoped messages. `broadcastToSession()` emits to `session:<id>` room. Global messages use `io.emit("message", msg)`.
- **SQLite `$param` binding**: Always `$paramName` syntax, never `?` or `:name`.
- **Empty body parser**: Custom `application/json` parser accepts bodyless POSTs (Stop HTTP hook sends no body).
- **Re-export bridges**: `prompt.js` re-exports `swarm-manager.js` and `git-worktree.js`. `db.js` re-exports `session-resolver.js`. Route files import from these bridges — do not change import paths in routes.
- **`resetClient()` exports**: `diff-summary.js`, `commit.js`, and `crafting.js` each export `resetClient()`. `index.js` calls all three on `POST /api/vpn/reconfigure` so Anthropic clients pick up new proxy/TLS config.
- **Prompt identity**: `current_claude_session_id` tracks the real Claude CLI ID for `--resume`. Pass `null` for `$currentClaudeSessionId` during active prompts to avoid clobbering with ephemeral subprocess IDs.
- **Prompt fallback**: `sendPrompt()` retries as fresh `claude --print` when `--resume` exits non-zero with "no conversation found" in any output stream. Emits `prompt:context-lost` chunk before retrying.
- **Swarm slot reservation**: `spawnSwarmAgent()` inserts a `"pending"` entry into `activeSwarmAgents` before process spawn so concurrent calls respect `MAX_SWARM_AGENTS` correctly.
- **Model validation**: Swarm model strings validated against `/^[a-zA-Z0-9._/-]+$/` before passing to CLI args to prevent flag injection.
- **CWD validation**: Diff, commit, and worktree endpoints call `existsSync(dir)` before spawning git. macOS `posix_spawn` gives misleading `ENOENT` blaming the binary when CWD is missing.
- **Git root LRU**: `cachedGitRoot()` in `session-resolver.js` caches `git worktree list --porcelain` results in a 200-entry Map with insertion-order eviction. Pre-caches `root → root` at insertion time. Git I/O runs outside SQLite transactions to avoid holding write locks during shell-outs.
- **Agent auto-detection**: Events with `toolName: "Agent"` trigger automatic `agents` table insert in the post-tool-use hook handler. Prompt truncated to 2000 chars.
- **Diff summary cache**: SHA-256 keyed, 10-minute TTL, 100-entry LRU cap.
- **`DASHBOARD_SWARM_AGENT_ID` env var**: Passed to swarm agent subprocess so hooks route the agent's session registration separately from the parent.
- **`setImmediate` for merges**: Worktree merge replies to the HTTP request before running `git merge --no-ff` to avoid `bun --watch` restart killing the response mid-flight.
- **Startup dedup**: `deduplicateSessions()` runs at server start to merge any duplicate active sessions for the same `project_dir` caused by prior TOCTOU races. Keeps the oldest session, re-parents all data.
