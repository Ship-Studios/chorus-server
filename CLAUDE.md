# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

See also the [root CLAUDE.md](../../CLAUDE.md) for full project architecture, REST API docs, DB schema, and WebSocket protocol.

## Commands

```bash
# Dev server with hot reload
bun --watch src/index.js

# Run all tests
bun test src

# Run a single test file
bun test src/api.test.js
bun test src/prompt.test.js
bun test src/diff.test.js
```

## Package Overview

Fastify 5 server — plain JS (ESM, no build step), `bun:sqlite` for persistence, `@fastify/websocket` for real-time broadcast. Entry point: `src/index.js`.

## Module Responsibilities

- **`db.js`** — Schema creation (7 tables), all prepared statements (exported), cascading session deletion. Re-exports `resolveSessionId`/`lookupSessionId` from `session-resolver.js` for backward compatibility. Exports alias-related prepared statements (`getAlias`, `insertAlias`, `findActiveSessionByDir`, etc.) consumed by the session resolver.
- **`session-resolver.js`** — Session alias resolution (`resolveSessionId` / `lookupSessionId`) with git root caching (200-entry LRU). The alias system maps multiple Claude CLI session IDs to one dashboard session via a 5-step resolution chain (alias → active dir → recent dir → git root → new). Extracted from `db.js` to separate declarative SQL from resolution logic.
- **`broadcast.js`** — `wsClients` Set + `broadcast()` helper. Every route that mutates state calls `broadcast()` to push updates.
- **`git.js`** — Resolves a working `git` binary at startup (handles VPN-blocked paths). Exports `GIT` constant used everywhere.
- **`run-git.js`** — Promise-based `spawn(GIT, args, { cwd })` with timeout (30s) and buffer limits (10MB).
- **`diff.js`** — Parses unified diff output into `{ oldFileName, newFileName, fileLang, hunks }` for the `@git-diff-view/svelte` component.
- **`stream-parser.js`** — Line-buffered JSON stream parser for Claude CLI `--output-format stream-json` output. Exports `createStreamParser(onChunk)` returning `{ feed(data), flush() }`. Used by both `prompt.js` and `swarm-manager.js`.
- **`prompt.js`** — Manages `claude --resume`/`--print` subprocesses for prompt submission. Streams JSON chunks via WebSocket. One active prompt per session (409 on conflict). Re-exports swarm functions from `swarm-manager.js` and git functions from `git-worktree.js` for backward compatibility.
- **`swarm-manager.js`** — Manages lifecycle of swarm agents spawned via `POST /api/swarm/spawn`. Handles process spawning, streaming, auto-commit of worktree changes, and cleanup. Extracted from `prompt.js` to separate prompt lifecycle from swarm lifecycle.
- **`git-worktree.js`** — Git worktree operations: `createWorktree`, `removeWorktree` (with retry), `deleteBranch`, `getBranchDiffStats`, `detectConflicts`, `getCurrentBranch`, `slugify`. Extracted from `prompt.js` to isolate git operations from process management.
- **`summarize-diff.js`** — Core diff summarization via `@anthropic-ai/sdk`. Exports the system/user prompts and `summarizeDiff()` so the same logic is shared between the route handler and the eval suite (`src/evals/`).
- **`architecture.js`** — Project source file scanner that builds directory trees and import-graph flows for the architecture visualization. 30s in-memory cache per project.

## Route Modules (`src/routes/`)

Each file exports a default async Fastify plugin function. Registered in `index.js`.

| File | Prefix | Notes |
|------|--------|-------|
| `sessions.js` | `/api/sessions` | Upsert, stop, list, delete. Skips stop if prompt subprocess is active. |
| `events.js` | `/api/events` | Create + query. Auto-detects `Agent` tool calls → inserts into `agents` table. Uses `resolveSessionId` (not `lookupSessionId`) so events auto-create sessions. |
| `diff.js` | `/api/sessions/:id/diff` | Shells out to `git diff HEAD`. Validates CWD exists before spawning (macOS `posix_spawn` ENOENT workaround). |
| `prompt.js` | `/api/sessions/:id/prompt` | Submit, cancel, status. Image attachment support (base64 → temp file). |
| `swarm.js` | `/api/sessions/:id/swarm`, `/api/swarm/:agentId` | Spawn independent Claude processes. Worktree isolation via `git worktree add -b`. |
| `worktrees.js` | `/api/worktrees/:id` | Diff, file list, merge (`git merge --no-ff`), discard, conflict check. Merge uses `setImmediate` to reply before running git (avoids `bun --watch` restart). |
| `diff-summary.js` | `/api/sessions/:id/diff/summary` | AI-generated diff summary. SHA-256 cache (60s TTL). Requires `ANTHROPIC_API_KEY`. |
| `architecture.js` | `/api/sessions/:id/architecture` | Returns scanned project tree + import flows. |
| `crafting.js` | `/api/craft/*` | CRUD for agent crafting workbench (agents + recipes). AI synthesis via `POST /api/craft/synthesize`. Status check via `GET /api/craft/ai-status`. Uses `craft_agents` and `craft_recipes` tables. |

## Testing Approach

Tests use `bun:test` with Fastify's `app.inject()` for HTTP testing (no real server needed). `api.test.js` creates an in-memory SQLite DB and rebuilds the schema + route handlers inline — it does **not** import from `db.js` to avoid touching the real `dashboard.db`. The test's `resolveSessionId` is a simplified version (no git root resolution).

Route-specific tests (`routes-*.test.js`) cover individual route modules. Unit tests exist for core modules (`db.test.js`, `diff.test.js`, `broadcast.test.js`, `git.test.js`, `run-git.test.js`, `summarize-diff.test.js`, `architecture.test.js`).

## Key Patterns

- **SQLite parameter binding**: Always `$paramName` syntax (not `?` or `:name`)
- **Empty body handling**: Custom Fastify content-type parser accepts empty JSON bodies (needed for the stop hook's bodyless POST)
- **Worktree merge timing**: `setImmediate` wraps git operations that modify the working tree, so the HTTP response is sent before `bun --watch` detects file changes and restarts the server
- **Prompt subprocess identity**: `current_claude_session_id` on the sessions table tracks the real Claude CLI ID for `--resume`. When a prompt subprocess is active, session upserts pass `null` to avoid overwriting it with the subprocess's ephemeral ID.
- **Git root caching**: `cachedGitRoot()` in `session-resolver.js` caches `git worktree list` results (Map, 200-entry cap with LRU eviction) to avoid repeated `execFileSync` calls during alias resolution
- **Re-export bridges**: `prompt.js` re-exports swarm functions from `swarm-manager.js` and git functions from `git-worktree.js`. `db.js` re-exports `resolveSessionId`/`lookupSessionId` from `session-resolver.js`. This preserves backward compatibility — route files import from the original module paths without needing changes.
