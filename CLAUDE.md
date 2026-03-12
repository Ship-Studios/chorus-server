# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

See also the [root CLAUDE.md](../../CLAUDE.md) for full project architecture, REST API docs, DB schema, and WebSocket protocol.

## Commands

```bash
# Dev server with hot reload
bun --watch src/index.js

# Run all tests (279 tests across 18 files)
bun test src

# Run a single test file
bun test src/api.test.js
bun test src/routes-crafting.test.js

# Run diff-summary evals (calls real Anthropic API)
ANTHROPIC_API_KEY=sk-... bun run eval:diff-summary
```

## Package Overview

Fastify 5 server -- plain JS (ESM, no build step), `bun:sqlite` for persistence, `@fastify/websocket` for real-time broadcast. Entry point: `src/index.js`. No TypeScript, no transpilation. Runs directly on Bun.

## Module Responsibilities

- **`index.js`** -- Fastify app setup, route registration, WebSocket upgrade handler, CORS, custom empty-body JSON parser, `@fastify/static` for production UI serving.
- **`db.js`** -- Schema creation (7 tables), 40+ prepared statements (exported), cascading session deletion. Re-exports `resolveSessionId`/`lookupSessionId` from `session-resolver.js` for backward compatibility.
- **`session-resolver.js`** -- Session alias resolution (`resolveSessionId` / `lookupSessionId`) with 5-step resolution chain (alias -> active dir -> recent dir -> git root -> new). Git root cached in 200-entry LRU Map.
- **`broadcast.js`** -- `wsClients` Set + `broadcast(type, data)` helper. Every mutating route calls this.
- **`git.js`** -- Resolves working `git` binary at startup (handles VPN-blocked `/usr/bin/git`). Exports `GIT` constant.
- **`run-git.js`** -- Promise-based `runGit(args, cwd)` via `spawn()` with 30s timeout and 10MB buffer limit.
- **`diff.js`** -- Parses unified diff into `{ oldFileName, newFileName, fileLang, hunks }` for `@git-diff-view/svelte`. Auto-detects file language from extension.
- **`stream-parser.js`** -- Line-buffered JSON parser for Claude CLI `--output-format stream-json`. Exports `createStreamParser(onChunk)` returning `{ feed(data), flush() }`.
- **`prompt.js`** -- Manages `claude --resume`/`--print` subprocesses. One active prompt per session (409 on conflict). Falls back to fresh `--print` if `--resume` fails (expired session). Re-exports from `swarm-manager.js` and `git-worktree.js`.
- **`swarm-manager.js`** -- Swarm agent lifecycle: spawn `claude --print` processes, stream output, auto-commit worktree changes, cleanup on exit.
- **`git-worktree.js`** -- Git worktree ops: `createWorktree`, `removeWorktree` (with retry), `deleteBranch`, `getBranchDiffStats`, `detectConflicts`, `getCurrentBranch`, `slugify`.
- **`summarize-diff.js`** -- AI diff summarization via `@anthropic-ai/sdk`. Exports prompts and `summarizeDiff()` shared between route and eval suite.
- **`architecture.js`** -- Project source scanner building directory trees + import-graph flows. 30s in-memory cache per project.

## Route Files

Each exports a default async Fastify plugin. Registered in `index.js`.

| File | Endpoints | Purpose |
|------|-----------|---------|
| `sessions.js` | `POST /api/sessions`, `POST /:id/stop`, `GET /api/sessions`, `DELETE /:id` | Session upsert, stop, list, delete. Skips stop if prompt active. |
| `events.js` | `POST /api/events`, `GET /api/events`, `GET /api/events/:id`, `GET /api/sessions/:id/events`, `GET /api/sessions/:id/agents` | Event CRUD + agent auto-detection from `Agent` tool calls. |
| `diff.js` | `GET /api/sessions/:id/diff` | Git diff with parsed file hunks. Validates CWD exists (macOS ENOENT workaround). |
| `diff-summary.js` | `POST /api/sessions/:id/diff/summary`, `GET /api/diff-summary/status` | AI diff summary. SHA-256 cache (60s TTL, 100 entries). Requires `ANTHROPIC_API_KEY`. |
| `prompt.js` | `POST /api/sessions/:id/prompt`, `POST /:id/prompt/cancel`, `GET /:id/prompt/status` | Submit/cancel/status for prompt subprocesses. Image attachment support. |
| `swarm.js` | `POST /api/sessions/:id/swarm/spawn`, `POST /api/swarm/:agentId/cancel`, `GET /api/sessions/:id/swarm` | Spawn independent Claude agents. Optional worktree isolation. |
| `worktrees.js` | `GET /api/worktrees/:id/diff`, `GET /:id/files`, `POST /:id/merge`, `DELETE /:id`, `POST /:id/check-conflicts`, `GET /api/sessions/:id/worktrees` | PR-like review: diff, merge (`--no-ff`), discard, conflict check. |
| `architecture.js` | `GET /api/sessions/:id/architecture` | Project source tree + import graph. |
| `crafting.js` | `GET/POST /api/craft/agents`, `PUT/DELETE /:id`, `GET/POST /api/craft/recipes`, `PUT/DELETE /:id`, `POST /api/craft/synthesize`, `GET /api/craft/ai-status` | Agent crafting workbench CRUD + AI synthesis. |

## Testing Approach

18 test files, 279 tests, `bun:test`. Run with `bun test src`.

- **`api.test.js`** (55 tests) -- Integration tests using in-memory SQLite + `app.inject()`. Rebuilds schema inline (does **not** import `db.js` to avoid touching real `dashboard.db`). Uses simplified `resolveSessionId`.
- **`routes-*.test.js`** (7 files, 93 tests) -- Route-specific integration tests for each route module.
- **Unit tests** (10 files, 131 tests) -- `db.test.js`, `diff.test.js`, `broadcast.test.js`, `git.test.js`, `run-git.test.js`, `prompt.test.js`, `git-worktree.test.js`, `stream-parser.test.js`, `summarize-diff.test.js`, `architecture.test.js`.
- **Evals** (`src/evals/diff-summary.eval.js`) -- Calls real Anthropic API. Not part of normal test suite. Run separately with `ANTHROPIC_API_KEY`.

## Key Patterns

- **SQLite `$param` binding**: Always `$paramName` syntax, never `?` or `:name`.
- **Empty body parser**: Custom Fastify `application/json` parser accepts empty bodies (stop hook sends bodyless POST).
- **`setImmediate` for merges**: Worktree merge replies before running `git merge --no-ff` to avoid `bun --watch` restart killing the response.
- **Prompt identity**: `current_claude_session_id` tracks the real Claude CLI ID for `--resume`. Session upserts pass `null` during active prompts to avoid overwriting with ephemeral subprocess IDs.
- **Git root LRU**: `cachedGitRoot()` in `session-resolver.js` caches `git worktree list` results (200-entry Map with LRU eviction).
- **Re-export bridges**: `prompt.js` re-exports from `swarm-manager.js` and `git-worktree.js`. `db.js` re-exports from `session-resolver.js`. Preserves backward compatibility for route imports.
- **Agent auto-detection**: Events with `toolName: "Agent"` trigger automatic insertion into the `agents` table with metadata extracted from `tool_input`.
- **Prompt fallback**: If `--resume` fails with "no conversation found", automatically retries as fresh `claude --print`.
- **CWD validation**: Diff endpoint checks `existsSync(dir)` before spawning git. macOS `posix_spawn` gives misleading ENOENT when CWD is missing.
