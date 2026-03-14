# @chorus/server

Fastify 5 backend for the Chorus dashboard. Receives Claude Code hook events, persists them to SQLite, and broadcasts real-time updates to connected browser clients over Socket.IO.

## Usage

```bash
# Development (hot reload)
bun --watch src/index.js

# Production (started by bin/dashboard.js via `bun run start` / `chorus`)
bun src/index.js
```

Environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3001` | Listen port |
| `HOST` | `127.0.0.1` | Listen host |
| `ANTHROPIC_API_KEY` | — | Required for diff summary, commit message, and crafting synthesis endpoints |
| `DASHBOARD_API_KEY` | — | Optional API key guard for non-GET `/api` requests |
| `MAX_SWARM_AGENTS` | `10` | Concurrent swarm agent limit |
| `CHORUS_ROOT_DIR` | `~/Documents/code` | Root scanned for sidebar project list (falls back to `PULSE_ROOT_DIR`) |
| `FORCE_VPN_MODE` | — | Skip VPN detection, assume on-VPN |
| `FORCE_OFF_VPN` | — | Skip VPN detection, assume off-VPN |

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
| `GET` | `/api/sessions/:id/diff` | Git diff with parsed file hunks |
| `DELETE` | `/api/sessions/:id` | Delete session and all associated data |
| `GET` | `/api/events` | Recent events across all sessions (last 100) |
| `GET` | `/api/events/:id` | Single event with full payload |
| `GET` | `/api/health` | Liveness probe + VPN diagnostic state |

### Prompt and swarm endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/api/sessions/:id/prompt` | Submit prompt via `claude --resume`, streams chunks |
| `POST` | `/api/sessions/:id/prompt/cancel` | Cancel active prompt |
| `GET` | `/api/sessions/:id/prompt/status` | `{ active: boolean }` |
| `POST` | `/api/sessions/:id/swarm/spawn` | Spawn independent Claude agent |
| `POST` | `/api/swarm/:agentId/cancel` | Cancel a swarm agent |
| `GET` | `/api/sessions/:id/swarm` | List active swarm agents |

### Worktree and code-intel endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| `GET` | `/api/sessions/:id/worktrees` | List worktree branches |
| `GET` | `/api/worktrees/:id/diff` | Three-dot diff for a branch |
| `POST` | `/api/worktrees/:id/merge` | Merge branch via `git merge --no-ff` |
| `DELETE` | `/api/worktrees/:id` | Discard worktree and branch |
| `POST` | `/api/sessions/:id/diff/summary` | AI-generated diff summary |
| `POST` | `/api/sessions/:id/commit` | AI commit message + `git commit` |
| `GET` | `/api/sessions/:id/architecture` | Source tree + import graph |

### Crafting endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| `GET/POST` | `/api/craft/agents` | List / create craft agents |
| `PUT/DELETE` | `/api/craft/agents/:id` | Update / delete a craft agent |
| `GET/POST` | `/api/craft/recipes` | List / create recipes |
| `PUT/DELETE` | `/api/craft/recipes/:id` | Update / delete a recipe |
| `POST` | `/api/craft/synthesize` | AI-synthesize prompt from 2+ agents |

### WebSocket (Socket.IO)

Connect to the server with a Socket.IO client. On connection, the server immediately emits an `init` message with current sessions, events, agents, and worktrees.

All server-to-client messages are emitted as the `"message"` event carrying a typed payload object (e.g. `{ type: "session:updated", session }`, `{ type: "event:new", event }`).

Room management: emit `join-session` with a session ID to subscribe to session-scoped messages (prompt chunks, diff invalidations, swarm output). Emit `leave-session` to unsubscribe.

## Development

```bash
# Run all tests
bun test src

# Run a single test file
bun test src/broadcast.test.js

# Evals (real Anthropic API -- not CI)
ANTHROPIC_API_KEY=sk-... bun run eval:diff-summary
```

Tests use `bun:test`. Integration tests build in-memory Fastify apps with in-memory SQLite — they never touch `dashboard.db`. Broadcast tests inject a mock Socket.IO object via `setIO()`.

## Architecture

```
index.js            -- Fastify bootstrap, Socket.IO init, route registration
socket.js           -- getIO/setIO singleton (set after app.ready())
broadcast.js        -- global + session-scoped emit helpers, diff debounce
db.js               -- bun:sqlite schema, prepared statements, cascade delete
session-resolver.js -- 5-step alias resolution, 200-entry git root LRU cache
prompt.js           -- claude --resume subprocess, cancel, fallback, re-export bridge
swarm-manager.js    -- independent agent spawn, worktree isolation, auto-commit
git-worktree.js     -- worktree create/remove, branch ops, conflict detection
stream-parser.js    -- line-buffered JSON parser for claude --output-format stream-json
git-watcher.js      -- chokidar watchers on .git internals, broadcasts diff:invalidated
architecture.js     -- source tree walker + import graph, 30s cache
vpn.js              -- VPN probe, proxy/cert env setup, Anthropic fetch options
routes/             -- one Fastify plugin per feature area
```

The database lives at `packages/server/dashboard.db` (created on first run). Seven tables: `sessions`, `events`, `session_aliases`, `agents`, `worktrees`, `craft_agents`, `craft_recipes`. WAL mode, foreign keys enforced, all parameters use `$name` binding syntax.

Diff parsing and git utilities are shared from `@chorus/diff-panel` (workspace package). Re-export bridges in `git.js`, `run-git.js`, `diff.js`, and `summarize-diff.js` keep route import paths stable.
