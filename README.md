# @agent-dashboard/server

Fastify 5 REST API and WebSocket server for the Agent Dashboard. Receives lifecycle events from Claude Code hooks, persists them in SQLite, and broadcasts real-time updates to connected dashboard UI clients. Also supports sending prompts to Claude Code sessions, spawning independent swarm agents with optional worktree isolation, and AI-powered diff summarization.

## Quick Start

```bash
# Install dependencies (from repo root)
bun install

# Run with file watcher
bun run dev

# Or directly
bun --watch src/index.js
```

The server starts on port 3001 by default. No build step is required -- the server runs plain ESM JavaScript directly on Bun.

## Configuration

| Environment Variable | Default | Description |
|----------------------|---------|-------------|
| `PORT` | `3001` | HTTP/WebSocket listen port |
| `HOST` | `127.0.0.1` | Listen host |
| `ANTHROPIC_API_KEY` | *(unset)* | Required for AI diff summaries via `@anthropic-ai/sdk` |
| `DIFF_SUMMARY_MODEL` | `claude-haiku-4-5-20251001` | Model for diff summarization (overridable) |

The SQLite database file is created at `packages/server/dashboard.db` (resolved relative to `src/`). WAL journal mode and foreign keys are enabled at startup.

## Architecture

```
Claude Code hooks (bash/jq)
        |
        v
   POST /api/sessions, /api/events, /api/sessions/:id/stop
        |
        v
   Fastify server (:3001)
        |
        +---> bun:sqlite (dashboard.db)
        |
        +---> WebSocket broadcast to all connected UI clients
        |
        +---> @fastify/static serves built UI (production)
```

Source files:

- `src/index.js` -- Fastify app, route registration, WebSocket setup, static file serving
- `src/db.js` -- SQLite schema (7 tables), prepared statements, cascading deletion
- `src/session-resolver.js` -- Session alias resolution (5-step chain) with git root caching
- `src/broadcast.js` -- WebSocket client tracking and broadcast utility
- `src/git.js` -- Git binary resolution with VPN fallback paths
- `src/run-git.js` -- Promise-based git spawning with timeout and buffer limits
- `src/diff.js` -- Unified diff parsing for `@git-diff-view/svelte`
- `src/stream-parser.js` -- Line-buffered JSON stream parser for Claude CLI output
- `src/prompt.js` -- Claude CLI subprocess management for prompt submission
- `src/swarm-manager.js` -- Swarm agent lifecycle (spawn, cancel, worktree isolation, auto-commit)
- `src/git-worktree.js` -- Git worktree operations (create, remove, diff stats, conflict detection)
- `src/summarize-diff.js` -- AI diff summarization via `@anthropic-ai/sdk`
- `src/architecture.js` -- Project source file scanner for architecture visualization

## REST API Reference

### Hook Endpoints (called by Claude Code lifecycle hooks)

#### POST /api/sessions

Register or heartbeat a session. Creates a new session or updates `last_seen_at` for an existing one. Uses `resolveSessionId()` to deduplicate CLI reconnects.

**Request body:**
```json
{
  "sessionId": "claude-cli-session-id",
  "projectDir": "/path/to/project",
  "worktreeDir": "/path/to/worktree",
  "model": "claude-sonnet-4-20250514"
}
```

- `sessionId` (required) -- The Claude Code CLI session ID.
- `projectDir` -- Working directory. Defaults to `"unknown"`.
- `worktreeDir` -- Git worktree directory, if applicable.
- `model` -- Model name. Preserved across upserts (not overwritten with null).

**Response:** `{ "ok": true }`

Broadcasts `sessions:update` to all WebSocket clients.

---

#### POST /api/sessions/:sessionId/stop

Mark a session as stopped. Accepts an empty body (the stop hook sends no payload). Skipped if a prompt subprocess is currently active for the session.

**URL params:**
- `sessionId` -- The Claude Code CLI session ID (resolved via `lookupSessionId()`).

**Response:** `{ "ok": true }`

Broadcasts `sessions:update` to all WebSocket clients.

---

#### POST /api/events

Log a tool use event. Auto-creates the session if it does not exist yet (handles race conditions where PostToolUse arrives before SessionStart). Automatically detects Agent tool calls and creates agent records.

**Request body:**
```json
{
  "sessionId": "claude-cli-session-id",
  "projectDir": "/path/to/project",
  "type": "tool_use",
  "toolName": "Edit",
  "filePath": "/path/to/file.ts",
  "summary": "Edited file.ts",
  "payload": { "input": { ... }, "output": { ... } }
}
```

- `sessionId` (required) -- The Claude Code CLI session ID.
- `type` -- Event type. Defaults to `"tool_use"`.
- `toolName` -- Name of the tool (Edit, Write, Read, Bash, Glob, Grep, Agent, etc.).
- `filePath` -- Primary file affected.
- `summary` -- Human-readable summary.
- `payload` -- Full tool input/output (JSON, stored as string, ~50KB limit from hooks).

**Response:** `{ "ok": true }`

Broadcasts `event:new` to all WebSocket clients. If `toolName` is `"Agent"`, also broadcasts `agent:new`.

---

### Query Endpoints

#### GET /api/sessions

List all sessions, ordered by `started_at` descending. Limited to 50.

**Response:** Array of session objects.

---

#### GET /api/sessions/:sessionId/events

Get events for a specific session, ordered by `created_at` descending. Limited to 200.

---

#### GET /api/events

Recent events across all sessions, ordered by `created_at` descending. Limited to 100. Includes `project_dir` from the joined sessions table.

---

#### GET /api/events/:eventId

Get a single event with full payload. Returns 404 if not found.

---

#### DELETE /api/sessions/:sessionId

Delete a stopped session and all associated data (events, agents, worktrees, aliases). Returns 400 if the session is still active.

---

#### GET /api/sessions/:sessionId/agents

Get all agent records for a session, ordered by `created_at` descending.

---

#### GET /api/sessions/:sessionId/diff

Get the current git diff for a session's working directory. Shells out to `git diff HEAD` in the session's `project_dir`. Falls back to `git diff` (no HEAD) for repos with no commits. Validates directory exists before spawning (macOS `posix_spawn` ENOENT workaround).

**Response:**
```json
{
  "sessionId": "session-id",
  "directory": "/path/to/project",
  "branch": "main",
  "stat": " file.ts | 5 +++--",
  "diff": "diff --git a/file.ts b/file.ts...",
  "files": [
    {
      "oldFileName": "file.ts",
      "newFileName": "file.ts",
      "fileLang": "typescript",
      "hunks": [...],
      "hunkCount": 1
    }
  ]
}
```

The `files` array is structured for use with `@git-diff-view/svelte`. The `fileLang` is auto-detected from the file extension.

---

#### GET /api/sessions/:sessionId/architecture

Get the project source tree and import graph for architecture visualization. Files are scanned with configurable depth (8 levels), file limit (400), and size limit (256KB). Results are cached for 30 seconds per project directory.

---

### Diff Summary Endpoints

#### POST /api/sessions/:sessionId/diff/summary

Generate an AI-powered summary of the session's current diff. Returns 503 if `ANTHROPIC_API_KEY` is not set. Results are cached by SHA-256 hash of the diff content (60s TTL, 100-entry cap).

**Response:**
```json
{
  "summary": "This change adds validation...",
  "model": "claude-haiku-4-5-20251001",
  "cached": false
}
```

#### GET /api/diff-summary/status

Check if the diff summary feature is available (API key configured).

**Response:** `{ "available": true|false }`

---

### Prompt Endpoints

#### POST /api/sessions/:sessionId/prompt

Send a prompt to an existing Claude Code session by spawning `claude --print --resume <sessionId>`. Streams output chunks over WebSocket. Only one prompt can be active per session at a time (returns 409 if one is already running). Falls back to a fresh `claude --print` if `--resume` fails with "no conversation found" (session expiry).

**Request body:**
```json
{
  "prompt": "Fix the bug in utils.ts",
  "permissionMode": "default",
  "image": { "data": "base64...", "mimeType": "image/png" }
}
```

- `prompt` (required) -- The text prompt to send.
- `permissionMode` -- One of: `"default"`, `"acceptEdits"`, `"bypassPermissions"`, `"plan"`, `"dontAsk"`. Optional.
- `image` -- Optional base64-encoded image attachment (saved as temp file, prepended as file read instruction).

**Response:** `{ "ok": true, "sessionId": "dashboard-session-id" }`

Broadcasts `prompt:start`, then `prompt:chunk` for each output line, then `prompt:done` when the process exits.

---

#### POST /api/sessions/:sessionId/prompt/cancel

Cancel the running prompt for a session. Sends SIGTERM via AbortController.

**Response:** `{ "ok": true, "cancelled": true|false }`

---

#### GET /api/sessions/:sessionId/prompt/status

Check whether a prompt is currently running for a session.

**Response:** `{ "active": true|false }`

---

### Swarm Endpoints

#### POST /api/sessions/:sessionId/swarm/spawn

Spawn a new independent Claude Code agent process (not resuming an existing session). The agent runs in the parent session's `project_dir`, or in an isolated git worktree if `useWorktree: true`.

**Request body:**
```json
{
  "prompt": "Refactor the auth module",
  "description": "Auth refactor agent",
  "permissionMode": "acceptEdits",
  "maxTurns": 25,
  "model": "claude-sonnet-4-20250514",
  "useWorktree": true
}
```

- `prompt` (required) -- The task prompt.
- `description` -- Short label for the agent. Defaults to first 80 chars of prompt.
- `permissionMode` -- Same options as the prompt endpoint.
- `maxTurns` -- Maximum conversation turns. Defaults to 25.
- `model` -- Override the default model.
- `useWorktree` -- Run in isolated git worktree. Branch preserved after completion for review.

**Response:** `{ "ok": true, "agentId": "abc123def456" }`

Broadcasts `swarm:spawned`, then `swarm:chunk` for each output line, then `swarm:done` on exit. If `useWorktree` was set, also broadcasts `worktree:ready` with diff stats.

---

#### POST /api/swarm/:agentId/cancel

Cancel a running swarm agent.

**Response:** `{ "ok": true, "cancelled": true|false }`

---

#### GET /api/sessions/:sessionId/swarm

List active (in-memory) swarm agents for a session.

---

### Worktree Review Endpoints

#### GET /api/sessions/:sessionId/worktrees

List worktree records for a session. Auto-discovers branches from `git worktree list --porcelain` and creates DB records for untracked branches.

---

#### GET /api/worktrees/:worktreeId/diff

Diff a worktree branch against its base branch (`git diff base...branch`). Returns parsed files and stat summary.

---

#### GET /api/worktrees/:worktreeId/files

List changed files for a worktree branch (`git diff --name-status`). Returns `[{ status, file }]`.

---

#### POST /api/worktrees/:worktreeId/merge

Merge worktree branch into base via `git merge --no-ff`, then delete the branch. Uses `setImmediate` to send response before running git (avoids `bun --watch` restart). Errors broadcast via `worktree:updated` with `status: "error"`.

---

#### DELETE /api/worktrees/:worktreeId

Discard a worktree -- removes checkout, deletes branch (unless already merged), removes DB record.

---

#### POST /api/worktrees/:worktreeId/check-conflicts

Refresh conflict detection using `git merge-tree --write-tree` (non-destructive). Updates `conflict_info` column.

---

### Health

#### GET /api/health

**Response:** `{ "status": "ok", "uptime": 123.456 }`

---

## WebSocket Protocol

Connect to `ws://localhost:3001/ws`. All messages are JSON with a `type` field.

### Server-to-client messages

| Type | Payload | Trigger |
|------|---------|---------|
| `init` | `{ sessions[], recentEvents[] }` | On client connect |
| `sessions:update` | `{ sessions[] }` | Session created, updated, or stopped |
| `event:new` | `{ event }` | New tool use event logged |
| `agent:new` | `{ agent }` | Agent tool call detected |
| `prompt:start` | `{ sessionId, prompt }` | Prompt submitted |
| `prompt:chunk` | `{ sessionId, chunk }` | Streaming output chunk |
| `prompt:done` | `{ sessionId, exitCode, cancelled?, error? }` | Prompt completed or cancelled |
| `swarm:spawned` | `{ agentId, parentSessionId, description, startedAt }` | Swarm agent launched |
| `swarm:chunk` | `{ agentId, parentSessionId, chunk }` | Swarm agent output |
| `swarm:done` | `{ agentId, exitCode, cancelled?, description }` | Swarm agent exited |
| `worktree:ready` | `{ worktree, parentSessionId }` | Worktree branch ready for review |
| `worktree:updated` | `{ worktree, parentSessionId }` | Worktree record updated |
| `worktree:removed` | `{ worktreeId, parentSessionId }` | Worktree discarded |

---

## Database Schema

The database uses `bun:sqlite` (not `better-sqlite3`). File location: `packages/server/dashboard.db`. WAL journal mode and foreign keys are enabled.

All parameter bindings use the `$` prefix (e.g., `$id`, `$sessionId`).

### sessions

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | Dashboard session ID |
| `project_dir` | TEXT NOT NULL | Absolute path to the project directory |
| `worktree_dir` | TEXT | Git worktree directory, if applicable |
| `status` | TEXT NOT NULL | `active`, `stopped`, or `error` (default: `active`) |
| `model` | TEXT | Model name |
| `current_claude_session_id` | TEXT | Most recent Claude CLI session ID (for `--resume`) |
| `started_at` | TEXT NOT NULL | ISO datetime |
| `last_seen_at` | TEXT NOT NULL | ISO datetime, updated on each upsert |

### events

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Event ID |
| `session_id` | TEXT NOT NULL | FK to `sessions.id` |
| `type` | TEXT NOT NULL | Event type (e.g., `tool_use`) |
| `tool_name` | TEXT | Tool name |
| `file_path` | TEXT | Primary file affected |
| `summary` | TEXT | Human-readable summary |
| `payload` | TEXT | JSON string (~50KB limit) |
| `created_at` | TEXT NOT NULL | ISO datetime |

Indexes: `idx_events_session`, `idx_events_created`, `idx_events_session_created`

### session_aliases

Maps multiple Claude Code CLI session IDs to a single dashboard session.

| Column | Type | Description |
|--------|------|-------------|
| `claude_session_id` | TEXT PRIMARY KEY | The CLI-assigned session ID |
| `dashboard_session_id` | TEXT NOT NULL | FK to `sessions.id` |

### agents

Tracks sub-agents spawned via the Agent tool within a session.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Agent record ID |
| `session_id` | TEXT NOT NULL | FK to `sessions.id` |
| `event_id` | INTEGER | FK to `events.id` |
| `description` | TEXT | Short description of the agent's task |
| `agent_type` | TEXT | Agent type (e.g., `Explore`, `Plan`, `code-reviewer`) |
| `prompt` | TEXT | The prompt sent to the sub-agent (truncated to 2000 chars) |
| `status` | TEXT NOT NULL | Default: `completed` |
| `created_at` | TEXT NOT NULL | ISO datetime |

Index: `idx_agents_session`

### worktrees

Git branches from swarm agents, tracked for PR-like review.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Worktree record ID |
| `session_id` | TEXT NOT NULL | FK to `sessions.id` (cascade delete) |
| `branch_name` | TEXT NOT NULL | Git branch name |
| `base_branch` | TEXT NOT NULL | Base branch (default: `main`) |
| `description` | TEXT | Agent description |
| `agent_id` | TEXT | Swarm agent ID that created this |
| `status` | TEXT NOT NULL | `pending`, `ready`, `merged`, or `error` |
| `files_changed` | INTEGER | Number of changed files |
| `insertions` | INTEGER | Lines added |
| `deletions` | INTEGER | Lines removed |
| `diff_stat` | TEXT | Git diff stat output |
| `conflict_info` | TEXT | Conflict detection results (JSON) |
| `created_at` | TEXT NOT NULL | ISO datetime |
| `updated_at` | TEXT NOT NULL | ISO datetime |

Indexes: `idx_worktrees_session`, unique `idx_worktrees_branch` on `(session_id, branch_name)`

---

## Session Alias Resolution

Claude Code CLI may produce different session IDs across reconnects and resumes for the same logical conversation. The alias system ensures these all map to a single dashboard session.

### resolveSessionId(claudeSessionId, projectDir)

Used by `POST /api/sessions` and `POST /api/events`. Creates aliases as a side effect.

**Resolution order:**

1. **Existing alias** -- If `claude_session_id` already exists in `session_aliases`, return the mapped `dashboard_session_id`.
2. **Active session for same directory** -- Find active session with same `project_dir`.
3. **Recent session for same directory** -- Find any recent session with same `project_dir`.
4. **Git repo root match** -- Find session sharing the same git repo root (worktree support). Cached via `cachedGitRoot()` (200-entry LRU).
5. **New session** -- Create self-alias and return CLI session ID as new dashboard session ID.

### lookupSessionId(claudeSessionId)

Used by read-only endpoints. Does not create aliases or sessions. Falls back to the input ID if no alias found.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `fastify` ^5.3.3 | HTTP framework |
| `@fastify/websocket` ^11.2.0 | WebSocket support |
| `@fastify/cors` ^11.2.0 | Cross-origin requests |
| `@fastify/static` ^9.0.0 | Static file serving (production UI) |
| `chokidar` ^4.0.3 | File watching |
| `@anthropic-ai/sdk` | AI diff summarization (peer dependency) |
| `bun:sqlite` (built-in) | SQLite database driver |
