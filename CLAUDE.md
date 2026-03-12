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

- **`db.js`** — Schema creation, all prepared statements (exported), session alias resolution (`resolveSessionId` / `lookupSessionId`), cascading session deletion. The alias system is the most complex logic — maps multiple Claude CLI session IDs to one dashboard session via a 5-step resolution chain (alias → active dir → recent dir → git root → new).
- **`broadcast.js`** — `wsClients` Set + `broadcast()` helper. Every route that mutates state calls `broadcast()` to push updates.
- **`git.js`** — Resolves a working `git` binary at startup (handles VPN-blocked paths). Exports `GIT` constant used everywhere.
- **`run-git.js`** — Promise-based `spawn(GIT, args, { cwd })` with timeout (30s) and buffer limits (10MB).
- **`diff.js`** — Parses unified diff output into `{ oldFileName, newFileName, fileLang, hunks }` for the `@git-diff-view/svelte` component.
- **`prompt.js`** — Manages `claude --resume`/`--print` subprocesses. Streams JSON chunks via WebSocket. One active prompt per session (409 on conflict). Also handles swarm agent spawning with worktree isolation.
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
| `architecture.js` | `/api/sessions/:id/architecture` | Returns scanned project tree + import flows. |

## Testing Approach

Tests use `bun:test` with Fastify's `app.inject()` for HTTP testing (no real server needed). `api.test.js` creates an in-memory SQLite DB and rebuilds the schema + route handlers inline — it does **not** import from `db.js` to avoid touching the real `dashboard.db`. The test's `resolveSessionId` is a simplified version (no git root resolution).

## Key Patterns

- **SQLite parameter binding**: Always `$paramName` syntax (not `?` or `:name`)
- **Empty body handling**: Custom Fastify content-type parser accepts empty JSON bodies (needed for the stop hook's bodyless POST)
- **Worktree merge timing**: `setImmediate` wraps git operations that modify the working tree, so the HTTP response is sent before `bun --watch` detects file changes and restarts the server
- **Prompt subprocess identity**: `current_claude_session_id` on the sessions table tracks the real Claude CLI ID for `--resume`. When a prompt subprocess is active, session upserts pass `null` to avoid overwriting it with the subprocess's ephemeral ID.
- **Git root caching**: `cachedGitRoot()` in `db.js` caches `git worktree list` results (Map, 200-entry cap with LRU eviction) to avoid repeated `execFileSync` calls during alias resolution
