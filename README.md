# @chorus/server

Fastify 5 backend for the Chorus dashboard. Receives Claude Code hook events, persists them to SQLite or Supabase, and broadcasts real-time updates to connected browser clients over Socket.IO.

## Installation

```bash
bun install
```

## Usage

```bash
# Development (hot reload)
bun --watch src/index.js

# Production (started by bin/dashboard.js via `bun run start` or the `chorus` CLI)
bun src/index.js
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3001` | Listen port |
| `HOST` | `127.0.0.1` | Listen host |
| `ANTHROPIC_API_KEY` | -- | Required for diff summary, commit message, and crafting synthesis |
| `DASHBOARD_API_KEY` | -- | Optional Bearer token guard for `/api/` endpoints |
| `SUPABASE_DB_URL` | -- | PostgreSQL connection string; uses SQLite when unset |
| `DASHBOARD_DB_PATH` | `dashboard.db` | Override SQLite file path |
| `CHORUS_ROOT_DIR` | `~/Documents/code` | Root directory scanned for sidebar project list |
| `DATA_RETENTION_DAYS` | `30` | Days before old events and sessions are pruned |
| `FORCE_VPN_MODE` | -- | Skip VPN detection, assume on-VPN |
| `FORCE_OFF_VPN` | -- | Skip VPN detection, assume off-VPN |
| `CORS_ORIGINS` | localhost origins | Comma-separated allowed CORS origins |

## API

### Hook endpoints (called by Claude Code bash/HTTP hooks)

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/api/sessions` | Session heartbeat / registration (upsert) |
| `POST` | `/api/sessions/:id/stop` | Mark session stopped |
| `POST` | `/api/hooks/pre-tool-use` | Broadcasts `diff:pending` for write-op tools |
| `POST` | `/api/hooks/post-tool-use` | Logs event, invalidates diff, detects agents |
| `POST` | `/api/hooks/post-tool-use-failure` | Logs failed tool calls as `tool_error` events |
| `POST` | `/api/hooks/stop` | Delegates to session stop |

### Query endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/sessions` | List sessions (last 50) |
| `GET` | `/api/sessions/:id/events` | Session events (last 200) |
| `GET` | `/api/sessions/:id/agents` | Sub-agents for a session |
| `GET` | `/api/sessions/:id/diff` | Git diff with parsed file hunks (15s cache) |
| `DELETE` | `/api/sessions/:id` | Delete session and all associated data |
| `GET` | `/api/events` | Recent events across all sessions (last 100) |
| `GET` | `/api/events/:id` | Single event with full payload |
| `GET` | `/api/health` | Liveness probe + VPN diagnostic state |
| `GET` | `/api/directories` | List project directories under `CHORUS_ROOT_DIR` |

### Prompt endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/api/sessions/:id/prompt` | Submit prompt via Agent SDK, streams chunks over WebSocket |
| `POST` | `/api/sessions/:id/prompt/cancel` | Cancel active prompt |
| `GET` | `/api/sessions/:id/prompt/status` | `{ active: boolean }` |

### Settings endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/settings` | List all settings (secret values redacted) |
| `PUT` | `/api/settings` | Create or update a setting |
| `DELETE` | `/api/settings/:key` | Remove a setting |
| `GET` | `/api/settings/test-anthropic` | Test the current Anthropic API key |

### WebSocket (Socket.IO)

Connect to the server with a Socket.IO client on the default namespace. On connection, the server emits an `init` message with current sessions, events, agents, and worktrees.

Room management: emit `join-session` with a session ID to receive session-scoped messages. Emit `leave-session` to unsubscribe.

Local MCP daemons connect to the `/bridge` namespace to enable Agent SDK tool execution on the user's local filesystem.

## Development

```bash
# Run all tests
bun test src

# Run a single test file
bun test src/broadcast.test.js

# Evals (real Anthropic API -- not CI)
ANTHROPIC_API_KEY=sk-... bun run eval:diff-summary
```

Tests use `bun:test`. Integration tests build in-memory Fastify apps with in-memory SQLite -- they never touch `dashboard.db`. Broadcast tests inject a mock Socket.IO object via `setIO()`.

## Architecture

```
index.js              -- Fastify bootstrap, route registration, Socket.IO init
socket.js             -- getIO/setIO singleton
broadcast.js          -- global + session-scoped emit helpers, diff debounce
db-adapter.js         -- backend selector: SQLite (default) or Supabase/PostgreSQL
db.js                 -- bun:sqlite schema, prepared statements, cascade delete
session-resolver.js   -- 5-step alias resolution, 200-entry git root LRU cache
prompt-sdk.js         -- Agent SDK query(), resume fallback, cancel
agent-tools.js        -- Agent SDK tool definitions routed via /bridge namespace
git-worktree.js       -- worktree create/remove, branch ops, conflict detection
git-watcher.js        -- chokidar watchers, broadcasts diff:invalidated
diff-cache.js         -- 15s TTL in-memory cache for diff responses
dashboard-snapshot.js -- versioned init-payload cache for WebSocket connections
vpn.js                -- VPN probe, proxy/cert env setup, Anthropic fetch options
routes/               -- one Fastify plugin per feature area
```

Eight tables: `sessions`, `events`, `session_aliases`, `agents`, `worktrees`, `conversations`, `craft_agents`, `craft_recipes`, `settings`. WAL mode. All `bun:sqlite` parameters use `$name` binding syntax.
