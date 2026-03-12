# @agent-dashboard/server

Fastify 5 REST API and WebSocket server for the Agent Dashboard. Receives lifecycle events from Claude Code hooks, persists them in SQLite, and broadcasts real-time updates to connected dashboard UI clients. Also supports sending prompts to Claude Code sessions and spawning independent swarm agents via the CLI.

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
```

Source files:

- `src/index.js` -- Fastify app, route handlers, WebSocket setup, git diff logic
- `src/db.js` -- SQLite schema, prepared statements, session alias resolution
- `src/prompt.js` -- Claude CLI subprocess management for prompts and swarm agents

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

Mark a session as stopped. Accepts an empty body (the stop hook sends no payload).

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
```json
[
  {
    "id": "session-id",
    "project_dir": "/path/to/project",
    "worktree_dir": null,
    "status": "active",
    "model": "claude-sonnet-4-20250514",
    "started_at": "2025-01-15 12:00:00",
    "last_seen_at": "2025-01-15 12:05:00"
  }
]
```

---

#### GET /api/sessions/:sessionId/events

Get events for a specific session, ordered by `created_at` descending. Limited to 200.

**Response:** Array of event objects.
```json
[
  {
    "id": 42,
    "session_id": "session-id",
    "type": "tool_use",
    "tool_name": "Edit",
    "file_path": "/path/to/file.ts",
    "summary": "Edited file.ts",
    "payload": "{...}",
    "created_at": "2025-01-15 12:03:00"
  }
]
```

---

#### GET /api/events

Recent events across all sessions, ordered by `created_at` descending. Limited to 100. Includes `project_dir` from the joined sessions table.

---

#### GET /api/events/:eventId

Get a single event with full payload. Returns 404 if not found.

---

#### GET /api/sessions/:sessionId/agents

Get all agent records for a session, ordered by `created_at` descending.

**Response:** Array of agent objects.
```json
[
  {
    "id": 1,
    "session_id": "session-id",
    "event_id": 42,
    "description": "Explore the codebase",
    "agent_type": "Explore",
    "prompt": "Look at the src directory...",
    "status": "completed",
    "created_at": "2025-01-15 12:03:00"
  }
]
```

---

#### GET /api/sessions/:sessionId/diff

Get the current git diff for a session's working directory. Shells out to `git diff HEAD` in the session's `worktree_dir` (preferred) or `project_dir`. Falls back to `git diff` (no HEAD) for repos with no commits.

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
      "hunks": ["diff --git a/file.ts b/file.ts..."],
      "hunkCount": 1
    }
  ]
}
```

The `files` array is structured for use with `@git-diff-view/svelte`. The `fileLang` is auto-detected from the file extension.

---

### Prompt Endpoints

#### POST /api/sessions/:sessionId/prompt

Send a prompt to an existing Claude Code session by spawning `claude --print --resume <sessionId>`. Streams output chunks over WebSocket. Only one prompt can be active per session at a time (returns 409 if one is already running).

**Request body:**
```json
{
  "prompt": "Fix the bug in utils.ts",
  "permissionMode": "default"
}
```

- `prompt` (required) -- The text prompt to send.
- `permissionMode` -- One of: `"default"`, `"acceptEdits"`, `"bypassPermissions"`, `"plan"`, `"dontAsk"`. Optional.

**Response:** `{ "ok": true, "sessionId": "dashboard-session-id" }`

Broadcasts `prompt:start`, then `prompt:chunk` for each output line, then `prompt:done` when the process exits.

---

#### POST /api/sessions/:sessionId/prompt/cancel

Cancel the running prompt for a session. Sends SIGTERM via AbortController.

**Response:** `{ "ok": true, "cancelled": true|false }`

Broadcasts `prompt:done` with `cancelled: true` if a prompt was active.

---

#### GET /api/sessions/:sessionId/prompt/status

Check whether a prompt is currently running for a session.

**Response:** `{ "active": true|false }`

---

### Swarm Endpoints

#### POST /api/sessions/:sessionId/swarm/spawn

Spawn a new independent Claude Code agent process (not resuming an existing session). The agent runs in the same working directory as the parent session.

**Request body:**
```json
{
  "prompt": "Refactor the auth module",
  "description": "Auth refactor agent",
  "permissionMode": "acceptEdits",
  "maxTurns": 25,
  "model": "claude-sonnet-4-20250514"
}
```

- `prompt` (required) -- The task prompt.
- `description` -- Short label for the agent. Defaults to first 80 chars of prompt.
- `permissionMode` -- Same options as the prompt endpoint.
- `maxTurns` -- Maximum conversation turns. Defaults to 25.
- `model` -- Override the default model.

**Response:** `{ "ok": true, "agentId": "abc123def456" }`

Broadcasts `swarm:spawned`, then `swarm:chunk` for each output line, then `swarm:done` on exit.

---

#### POST /api/swarm/:agentId/cancel

Cancel a running swarm agent.

**Response:** `{ "ok": true, "cancelled": true|false }`

---

#### GET /api/sessions/:sessionId/swarm

List active (in-memory) swarm agents for a session.

**Response:** Array of active agent objects.
```json
[
  {
    "id": "abc123def456",
    "description": "Auth refactor agent",
    "status": "running",
    "startedAt": 1705312800000,
    "sessionId": "parent-session-id"
  }
]
```

---

### Health

#### GET /api/health

**Response:** `{ "status": "ok", "uptime": 123.456 }`

---

## WebSocket Protocol

Connect to `ws://localhost:3001/ws`. All messages are JSON with a `type` field.

### Server-to-client messages

#### `init`

Sent immediately on connection. Contains full current state.

```json
{
  "type": "init",
  "sessions": [ ... ],
  "recentEvents": [ ... ]
}
```

#### `sessions:update`

Sent whenever a session is created, updated, or stopped.

```json
{
  "type": "sessions:update",
  "sessions": [ ... ]
}
```

Contains the full list of sessions (same shape as `GET /api/sessions`).

#### `event:new`

Sent when a new tool use event is logged.

```json
{
  "type": "event:new",
  "event": {
    "id": 42,
    "sessionId": "session-id",
    "type": "tool_use",
    "toolName": "Edit",
    "filePath": "/path/to/file.ts",
    "summary": "Edited file.ts",
    "hasPayload": true,
    "createdAt": "2025-01-15T12:03:00.000Z"
  }
}
```

Note: The event object in WebSocket messages uses camelCase keys. The full payload is not included (use `GET /api/events/:id` to fetch it).

#### `agent:new`

Sent when an Agent tool call is detected and a new agent record is created.

```json
{
  "type": "agent:new",
  "agent": {
    "id": 1,
    "sessionId": "session-id",
    "eventId": 42,
    "description": "Explore the codebase",
    "agentType": "Explore",
    "status": "completed",
    "createdAt": "2025-01-15T12:03:00.000Z"
  }
}
```

#### `prompt:start`

Sent when a prompt submission begins.

```json
{
  "type": "prompt:start",
  "sessionId": "session-id",
  "prompt": "Fix the bug in utils.ts"
}
```

#### `prompt:chunk`

Sent for each line of output from the Claude CLI process. The `chunk` is either a parsed JSON object from the CLI's `stream-json` output format, or a `{ type: "raw", text: "..." }` / `{ type: "stderr", text: "..." }` wrapper.

```json
{
  "type": "prompt:chunk",
  "sessionId": "session-id",
  "chunk": { ... }
}
```

#### `prompt:done`

Sent when the prompt process exits.

```json
{
  "type": "prompt:done",
  "sessionId": "session-id",
  "exitCode": 0
}
```

When cancelled: `{ "type": "prompt:done", "sessionId": "...", "exitCode": null, "cancelled": true }`

#### `swarm:spawned`

Sent when a new swarm agent process is launched.

```json
{
  "type": "swarm:spawned",
  "agentId": "abc123def456",
  "parentSessionId": "session-id",
  "description": "Auth refactor agent",
  "startedAt": 1705312800000
}
```

#### `swarm:chunk`

Sent for each line of output from a swarm agent process.

```json
{
  "type": "swarm:chunk",
  "agentId": "abc123def456",
  "parentSessionId": "session-id",
  "chunk": { ... }
}
```

#### `swarm:done`

Sent when a swarm agent process exits.

```json
{
  "type": "swarm:done",
  "agentId": "abc123def456",
  "exitCode": 0,
  "description": "Auth refactor agent"
}
```

---

## Database Schema

The database uses `bun:sqlite` (not `better-sqlite3`). File location: `packages/server/dashboard.db`. WAL journal mode and foreign keys are enabled.

All parameter bindings use the `$` prefix (e.g., `$id`, `$sessionId`).

### sessions

| Column | Type | Description |
|--------|------|-------------|
| `id` | TEXT PRIMARY KEY | Dashboard session ID (usually the first Claude CLI session ID) |
| `project_dir` | TEXT NOT NULL | Absolute path to the project directory |
| `worktree_dir` | TEXT | Git worktree directory, if applicable |
| `status` | TEXT NOT NULL | `active`, `stopped`, or `error` (default: `active`) |
| `model` | TEXT | Model name (e.g., `claude-sonnet-4-20250514`) |
| `started_at` | TEXT NOT NULL | ISO datetime, defaults to `datetime('now')` |
| `last_seen_at` | TEXT NOT NULL | ISO datetime, updated on each upsert |

### events

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY AUTOINCREMENT | Event ID |
| `session_id` | TEXT NOT NULL | FK to `sessions.id` |
| `type` | TEXT NOT NULL | Event type (e.g., `tool_use`) |
| `tool_name` | TEXT | Tool name (Edit, Write, Read, Bash, Glob, Grep, Agent, etc.) |
| `file_path` | TEXT | Primary file affected |
| `summary` | TEXT | Human-readable summary |
| `payload` | TEXT | JSON string of the full tool input/output (~50KB limit) |
| `created_at` | TEXT NOT NULL | ISO datetime, defaults to `datetime('now')` |

**Indexes:**
- `idx_events_session` on `session_id`
- `idx_events_created` on `created_at`

### session_aliases

Maps multiple Claude Code CLI session IDs to a single canonical dashboard session ID.

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
| `event_id` | INTEGER | FK to `events.id` (the Agent tool event that spawned this) |
| `description` | TEXT | Short description of the agent's task |
| `agent_type` | TEXT | Agent type (e.g., `Explore`, `Plan`, `code-reviewer`, `general-purpose`) |
| `prompt` | TEXT | The prompt sent to the sub-agent (truncated to 2000 chars) |
| `status` | TEXT NOT NULL | Always `completed` for hook-detected agents (default: `completed`) |
| `created_at` | TEXT NOT NULL | ISO datetime, defaults to `datetime('now')` |

**Indexes:**
- `idx_agents_session` on `session_id`

---

## Session Alias Resolution

Claude Code CLI may produce different session IDs across reconnects and resumes for the same logical conversation. The alias system ensures these all map to a single dashboard session.

### resolveSessionId(claudeSessionId, projectDir)

Used by `POST /api/sessions` (the session start/heartbeat hook). Creates aliases as a side effect.

**Resolution order:**

1. **Existing alias** -- If `claude_session_id` already exists in `session_aliases`, return the mapped `dashboard_session_id`.
2. **Active session for same directory** -- Query `sessions` for an active session with the same `project_dir`, ordered by `last_seen_at` descending. If found, create an alias mapping this CLI session ID to that dashboard session and return it.
3. **Recent session for same directory** -- Same query but without the `status = 'active'` filter. If found, alias and return.
4. **New session** -- No match found. Create a self-alias (`claude_session_id -> claude_session_id`) and return the CLI session ID as the new dashboard session ID.

### lookupSessionId(claudeSessionId)

Used by all other endpoints (events, stop, queries). Read-only -- does not create aliases or sessions. Looks up the alias table and returns the `dashboard_session_id` if found, otherwise returns the input ID unchanged.

---

## Agent Detection

When `POST /api/events` receives an event with `toolName: "Agent"`, it automatically extracts agent metadata from the payload and creates a record in the `agents` table:

- `description` -- From `payload.input.description`, falling back to the first 120 characters of `payload.input.prompt`, falling back to `"Sub-agent"`.
- `agent_type` -- From `payload.input.subagent_type`, falling back to `"general-purpose"`.
- `prompt` -- From `payload.input.prompt`, truncated to 2000 characters.
- `status` -- Always set to `"completed"` (the hook fires after the tool has finished).

An `agent:new` WebSocket message is broadcast immediately after insertion.

---

## Prompt Submission

The server can send prompts to existing Claude Code sessions by spawning the `claude` CLI as a child process.

### How sendPrompt() works

1. Validates that no prompt is already running for the session (one-at-a-time per session).
2. Spawns `claude` with these flags:
   - `--print` -- Non-interactive mode.
   - `--output-format stream-json` -- Structured streaming JSON output.
   - `--max-turns 25` -- Safety limit on conversation turns.
   - `--resume <claudeSessionId>` -- Resume the existing CLI conversation.
   - `--verbose` -- Include tool use details in output.
   - `--permission-mode <mode>` -- If specified (valid values: `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`). The `bypassPermissions` mode also adds `--dangerously-skip-permissions`.
3. Streams stdout line-by-line. Each line is parsed as JSON and broadcast as a `prompt:chunk` WebSocket message. Non-JSON lines are wrapped in `{ type: "raw", text: "..." }`.
4. stderr output is logged and broadcast as `{ type: "stderr", text: "..." }` chunks.
5. On process exit, any remaining buffer is flushed, the prompt is removed from the active map, and `prompt:done` is broadcast.
6. Cancellation sends SIGTERM via AbortController.

### How spawnSwarmAgent() works

Similar to `sendPrompt()` but does NOT use `--resume`. Each swarm agent is a fresh `claude` process with its own session. Agents are tracked in an in-memory `Map` (not in the database `agents` table, which is for hook-detected Agent tool calls). Additional options include `--model` override and configurable `--max-turns`.

Swarm agents are identified by a truncated UUID (12 characters). Lifecycle events (`swarm:spawned`, `swarm:chunk`, `swarm:done`) are broadcast over WebSocket with the `parentSessionId` included.

---

## Custom JSON Parser

Fastify is configured with a custom `application/json` content type parser that accepts empty request bodies. This is necessary because the stop hook (`POST /api/sessions/:id/stop`) sends a POST with no body. Empty bodies are parsed as `{}`.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `fastify` ^5.3.3 | HTTP framework |
| `@fastify/websocket` ^11.2.0 | WebSocket support |
| `@fastify/cors` ^11.2.0 | Cross-origin requests (UI on different port) |
| `chokidar` ^4.0.3 | File watching |
| `bun:sqlite` (built-in) | SQLite database driver |
