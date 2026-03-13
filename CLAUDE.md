# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See also the [root CLAUDE.md](../../CLAUDE.md) for full project architecture, REST API docs, DB schema, and WebSocket protocol.

## Commands

```bash
# Dev server with hot reload
bun --watch src/index.js

# Run all tests (18 files)
bun test src

# Run a single test file
bun test src/api.test.js
bun test src/routes-crafting.test.js

# Run diff-summary evals (calls real Anthropic API)
ANTHROPIC_API_KEY=sk-... bun run eval:diff-summary
```

## Package Overview

Fastify 5 server — plain JS (ESM, no build step), `bun:sqlite` for persistence, `@fastify/websocket` for real-time broadcast. Entry point: `src/index.js`. No TypeScript, no transpilation. Runs directly on Bun.

## Module Responsibilities

| File | Role |
|------|------|
| `index.js` | Fastify app setup, plugin registration, WebSocket `/ws` handler with 50-client cap and 30s ping/pong heartbeat, `@fastify/static` for production UI serving, custom empty-body JSON parser |
| `db.js` | Schema creation (7 tables), all prepared statements (exported by name), `deleteSession()` transaction, re-exports `resolveSessionId`/`lookupSessionId` from `session-resolver.js` for backward compatibility |
| `session-resolver.js` | `resolveSessionId()` — 5-step alias resolution chain; `lookupSessionId()` — read-only alias lookup; `cachedGitRoot()` — 200-entry LRU caching `git worktree list` results |
| `broadcast.js` | `wsClients` Set + `broadcast()`. Skips closed clients (readyState 3), terminates slow clients with buffered > 1MB |
| `stream-parser.js` | `createStreamParser(onChunk)` — line-buffered JSON parser for `--output-format stream-json`. Returns `{ feed(data), flush() }`. 512KB safety valve; non-JSON lines emitted as `{ type: "raw", text }` |
| `prompt.js` | `sendPrompt()` — spawns `claude --resume/--print`, one active prompt per session (throws on conflict), SIGTERM→SIGKILL cancel escalation, auto-fallback to fresh session on "no conversation found". Re-exports from `swarm-manager.js` and `git-worktree.js` for backward compatibility |
| `swarm-manager.js` | `spawnSwarmAgent()` — fresh `claude --print` process, optional worktree isolation, auto-commit on exit, diff stats + conflict detection. `cancelSwarmAgent()` — SIGTERM→SIGKILL, branch cleanup on cancel. Cap: 10 agents (`MAX_SWARM_AGENTS`) |
| `git-worktree.js` | `createWorktree()`, `removeWorktree()` (3-attempt retry), `deleteBranch()`, `getBranchDiffStats()`, `detectConflicts()` via `git merge-tree --write-tree`, `getCurrentBranch()`, `slugify()` |
| `architecture.js` | `scanArchitecture()` — async directory walker (max 400 files, depth 8), import-graph parser (ES/CJS/Python/Go), directory tree builder with palette coloring and single-child collapse. `getArchitecture()` wraps it with a 30s in-memory cache |
| `vpn.js` | VPN detection and environment configuration. `configureVpn()` — startup probe (curl internal endpoint), sets `HTTP_PROXY`/`HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS`/`NO_PROXY` on `process.env` when on-VPN. `reconfigureVpn()` — live re-detection for mid-session toggling. `vpnState` — exported singleton with current VPN status. Supports `FORCE_VPN_MODE`, `FORCE_OFF_VPN`, `VPN_DETECTION_TIMEOUT`, `WALMART_CERT_PATH` overrides |
| `git-watcher.js` | Git directory watcher (chokidar). `startWatching(projectDir, sessionId)` — deduplicates by `project_dir`, watches `.git/HEAD`, `.git/index`, `.git/refs/` with 300ms debounce, broadcasts `diff:invalidated` to all sessions using that repo. `shutdownWatchers()` — closes all watchers on server stop |
| `git.js` | Re-export bridge: `GIT` from `@agent-dashboard/diff-panel/server` |
| `run-git.js` | Re-export bridge: `runGit` from `@agent-dashboard/diff-panel/server` |
| `diff.js` | Re-export bridge: `parseDiffToFiles`, `buildStatSummary` from `@agent-dashboard/diff-panel/server` |
| `summarize-diff.js` | Re-export bridge: `summarizeDiff`, `truncateDiff`, `buildUserPrompt`, `SYSTEM_PROMPT`, `DEFAULT_MODEL`, `MAX_DIFF_CHARS` from `@agent-dashboard/diff-panel/server` |

## Route Files

Each exports a default async Fastify plugin. Registered in `index.js`.

| File | Endpoints | Notes |
|------|-----------|-------|
| `sessions.js` | `POST /api/sessions`, `POST /:id/stop`, `GET /api/sessions`, `DELETE /:id` | Stop ignored if prompt active. Swarm agents bypass alias resolution. Worktree detection from `project_dir` mismatch |
| `events.js` | `POST /api/events`, `GET /api/events`, `GET /api/events/:id`, `GET /api/sessions/:id/events`, `GET /api/sessions/:id/agents` | Auto-creates session if missing (race guard). Auto-inserts `agents` row on `toolName: "Agent"` |
| `diff.js` | `GET /api/sessions/:id/diff` | `existsSync` guard before `git diff HEAD`; falls back to `git diff` for repos with no commits |
| `diff-summary.js` | `POST /api/sessions/:id/diff/summary`, `GET /api/diff-summary/status` | SHA-256 cache, 60s TTL, 100-entry cap. Returns `{ summary, model, cached }` |
| `prompt.js` | `POST /api/sessions/:id/prompt`, `POST /:id/prompt/cancel`, `GET /:id/prompt/status` | 15MB body limit (for base64 images). Image saved as temp file, deleted on `prompt:done`. 409 on concurrent prompt |
| `swarm.js` | `POST /api/sessions/:id/swarm/spawn`, `POST /api/swarm/:agentId/cancel`, `GET /api/sessions/:id/swarm` | 429 on agent cap exceeded. Worktree `ready`/`empty` status based on `filesChanged > 0` |
| `worktrees.js` | `GET /api/sessions/:id/worktrees`, `GET /api/worktrees/:id/diff`, `GET /:id/files`, `POST /:id/merge`, `DELETE /:id`, `POST /:id/check-conflicts` | List auto-discovers unregistered worktrees via `git worktree list`. Merge runs `git merge --no-ff` then deletes branch |
| `architecture.js` | `GET /api/sessions/:id/architecture` | Delegates to `getArchitecture()` (cached) |
| `crafting.js` | `GET/POST /api/craft/agents`, `PUT/DELETE /:id`, `GET/POST /api/craft/recipes`, `PUT/DELETE /:id`, `POST /api/craft/synthesize`, `GET /api/craft/ai-status` | Synthesis uses `claude-sonnet-4-6`. Model param validated via regex to prevent flag injection |

## Testing Approach

18 test files, `bun:test`. Run with `bun test src`.

- **`api.test.js`** — Integration tests using in-memory SQLite + `app.inject()`. Rebuilds schema inline (does NOT import `db.js` to avoid touching `dashboard.db`). Uses simplified `resolveSessionId`.
- **`routes-*.test.js`** (7 files) — Route-specific integration tests for each route module.
- **Unit tests** (10 files) — `db.test.js`, `diff.test.js`, `broadcast.test.js`, `git.test.js`, `run-git.test.js`, `prompt.test.js`, `git-worktree.test.js`, `stream-parser.test.js`, `summarize-diff.test.js`, `architecture.test.js`.
- **`src/evals/diff-summary.eval.js`** — Calls real Anthropic API. Not part of normal `bun test` run. Execute with `ANTHROPIC_API_KEY=sk-... bun run eval:diff-summary`.

## Key Patterns

- **SQLite `$param` binding**: Always `$paramName` syntax, never `?` or `:name`.
- **Empty body parser**: Custom `application/json` parser accepts bodyless POSTs (stop hook sends no body).
- **Re-export bridges**: `prompt.js` re-exports `swarm-manager.js` and `git-worktree.js`. `db.js` re-exports `session-resolver.js`. Route files import from these bridges — do not change import paths in routes.
- **Prompt identity**: `current_claude_session_id` tracks the real Claude CLI ID for `--resume`. Pass `null` for `$currentClaudeSessionId` during active prompts to avoid clobbering with ephemeral subprocess IDs.
- **Git root LRU**: `cachedGitRoot()` in `session-resolver.js` caches `git worktree list --porcelain` results, 200-entry Map with insertion-order eviction. Also pre-caches `root → root` at insertion time.
- **Agent auto-detection**: Events with `toolName: "Agent"` trigger automatic `agents` table insert in `events.js`. Prompt truncated to 2000 chars in DB.
- **Prompt fallback**: `sendPrompt()` retries as fresh `claude --print` when `--resume` exits non-zero with "no conversation found" in any output stream.
- **CWD validation**: Diff and worktree endpoints call `existsSync(dir)` before spawning git. macOS `posix_spawn` gives misleading `ENOENT` blaming the binary when CWD is missing.
- **Swarm slot reservation**: `spawnSwarmAgent()` inserts a `"pending"` entry into `activeSwarmAgents` before process spawn so concurrent calls respect the `MAX_SWARM_AGENTS` cap correctly.
- **Model validation**: `swarm-manager.js` validates model strings with `/^[a-zA-Z0-9._/-]+$/` before passing to CLI args to prevent flag injection.
- **WebSocket client limits**: `index.js` enforces a 50-client cap; `broadcast.js` enforces a 1MB per-client buffer cap.
- **Swarm agent `DASHBOARD_SWARM_AGENT_ID` env var**: Passed to swarm agent process so hooks can identify and route the agent's session registration separately.
