# @agent-dashboard/server

Fastify 5 REST API and WebSocket server for the Agent Dashboard. Receives lifecycle events from Claude Code hooks, persists them in SQLite, and broadcasts real-time updates to connected dashboard clients. Also supports interactive prompt submission, swarm agent spawning with worktree isolation, and AI-powered diff summarization.

## Quick Start

```bash
# Install dependencies (from monorepo root)
bun install

# Run with file watcher (hot reload)
bun --watch src/index.js

# Or from monorepo root
bun run dev:server
```

The server starts on `http://localhost:3001` by default. No build step -- runs plain ESM JavaScript directly on Bun.

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
        +---> bun:sqlite (dashboard.db) -- 7 tables, WAL mode
        |
        +---> WebSocket broadcast (/ws) to all connected UI clients
        |
        +---> @fastify/static serves built UI in production
```

### Source Modules

| Module | Purpose |
|--------|---------|
| `src/index.js` | App setup, route registration, WebSocket handler, static serving |
| `src/db.js` | Schema (7 tables), 40+ prepared statements, cascading deletion |
| `src/session-resolver.js` | 5-step session alias resolution with 200-entry git root LRU cache |
| `src/broadcast.js` | WebSocket client tracking and broadcast utility |
| `src/git.js` | Git binary resolution with VPN fallback paths |
| `src/run-git.js` | Promise-based git spawning (30s timeout, 10MB buffer) |
| `src/diff.js` | Unified diff parser for `@git-diff-view/svelte` |
| `src/stream-parser.js` | Line-buffered JSON stream parser for Claude CLI output |
| `src/prompt.js` | Claude CLI subprocess management (`--resume` / `--print`) |
| `src/swarm-manager.js` | Swarm agent lifecycle (spawn, stream, auto-commit, cleanup) |
| `src/git-worktree.js` | Git worktree operations (create, remove, diff, conflicts) |
| `src/summarize-diff.js` | AI diff summarization via `@anthropic-ai/sdk` |
| `src/architecture.js` | Project source tree scanner with 30s cache |

### Route Modules (`src/routes/`)

Each exports a default async Fastify plugin registered in `index.js`: `sessions.js`, `events.js`, `diff.js`, `diff-summary.js`, `prompt.js`, `swarm.js`, `worktrees.js`, `architecture.js`, `crafting.js`.

## API Endpoints

### Hook Endpoints (called by Claude Code lifecycle hooks)

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/sessions` | Register/heartbeat a session (upsert). Body: `{ sessionId, projectDir, worktreeDir?, model? }` |
| POST | `/api/sessions/:id/stop` | Mark session stopped (empty body OK) |
| POST | `/api/events` | Log a tool use event. Body: `{ sessionId, type?, toolName?, filePath?, summary?, payload? }` |

### Query Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/sessions` | List sessions (last 50) |
| GET | `/api/sessions/:id/events` | Session events (last 200) |
| GET | `/api/sessions/:id/diff` | Git diff with parsed file hunks |
| GET | `/api/sessions/:id/agents` | Sub-agent records for a session |
| GET | `/api/sessions/:id/architecture` | Project source tree + import graph |
| GET | `/api/events` | Recent events across all sessions (last 100) |
| GET | `/api/events/:id` | Single event with full payload |
| DELETE | `/api/sessions/:id` | Delete a stopped session and all associated data |
| GET | `/api/health` | Health check + uptime |

### Prompt Endpoints (interactive session control)

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/sessions/:id/prompt` | Submit prompt via `claude --resume`. Body: `{ prompt, permissionMode?, image? }`. Returns 409 if already active. |
| POST | `/api/sessions/:id/prompt/cancel` | Cancel active prompt (SIGTERM) |
| GET | `/api/sessions/:id/prompt/status` | Check if prompt is running |

### Swarm Endpoints (spawn independent agents)

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/sessions/:id/swarm/spawn` | Spawn Claude agent. Body: `{ prompt, description?, permissionMode?, maxTurns?, model?, useWorktree? }` |
| POST | `/api/swarm/:agentId/cancel` | Cancel a running swarm agent |
| GET | `/api/sessions/:id/swarm` | List active swarm agents |

### Worktree Review Endpoints (PR-like review)

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/sessions/:id/worktrees` | List worktree records for a session |
| GET | `/api/worktrees/:id/diff` | Diff worktree branch against base |
| GET | `/api/worktrees/:id/files` | List changed files (`--name-status`) |
| POST | `/api/worktrees/:id/merge` | Merge branch into base (`--no-ff`), delete branch |
| DELETE | `/api/worktrees/:id` | Discard worktree (delete branch + record) |
| POST | `/api/worktrees/:id/check-conflicts` | Refresh conflict detection |

### Diff Summary Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| POST | `/api/sessions/:id/diff/summary` | AI-generated diff summary (cached by SHA-256, 60s TTL). Requires `ANTHROPIC_API_KEY`. |
| GET | `/api/diff-summary/status` | Check if feature is available |

### Crafting Endpoints (agent workbench)

| Method | Route | Purpose |
|--------|-------|---------|
| GET/POST | `/api/craft/agents` | List / create craft agents |
| PUT/DELETE | `/api/craft/agents/:id` | Update / delete a craft agent |
| GET/POST | `/api/craft/recipes` | List / create recipes |
| PUT/DELETE | `/api/craft/recipes/:id` | Update / delete a recipe |
| POST | `/api/craft/synthesize` | AI-synthesize unified prompt from 2+ agents |
| GET | `/api/craft/ai-status` | Check if AI synthesis is available |

## Database

SQLite via `bun:sqlite` (not `better-sqlite3`). File: `dashboard.db` in the package root. WAL journal mode. Foreign keys enforced. All parameter bindings use `$` prefix.

### Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `sessions` | Dashboard sessions | `id` (TEXT PK), `project_dir`, `worktree_dir`, `status`, `model`, `current_claude_session_id`, `started_at`, `last_seen_at` |
| `events` | Tool use events | `id` (INTEGER PK AUTO), `session_id` FK, `type`, `tool_name`, `file_path`, `summary`, `payload` (JSON text), `created_at` |
| `session_aliases` | Maps CLI session IDs to dashboard sessions | `claude_session_id` (TEXT PK), `dashboard_session_id` |
| `agents` | Sub-agents detected from Agent tool calls | `id`, `session_id` FK, `event_id` FK, `description`, `agent_type`, `prompt`, `status`, `created_at` |
| `worktrees` | Git branches from swarm agents | `id`, `session_id` FK, `branch_name`, `base_branch`, `status` (pending/ready/merged/error), `files_changed`, `insertions`, `deletions`, `conflict_info` |
| `craft_agents` | Agent building blocks | `id`, `name`, `description`, `prompt_snippet`, `icon`, `color`, `tags` (JSON), `model_preference` |
| `craft_recipes` | Synthesized agent recipes | `id`, `name`, `description`, `synthesized_prompt`, `ingredient_ids` (JSON), `icon`, `color`, `tags` (JSON), `model_preference` |

### Session Alias Resolution

Multiple Claude CLI session IDs map to one dashboard session via `resolveSessionId()`:

1. Existing alias lookup
2. Active session for same `project_dir`
3. Recent session for same `project_dir`
4. Session sharing same git repo root (worktree support, cached)
5. No match -- create new session

## WebSocket

Connect to `ws://localhost:3001/ws`. All messages are JSON with a `type` field.

| Type | Payload | Trigger |
|------|---------|---------|
| `init` | `{ sessions[], recentEvents[] }` | Client connects |
| `sessions:update` | `{ sessions[] }` | Session created/updated/stopped |
| `event:new` | `{ event }` | New tool use event |
| `agent:new` | `{ agent }` | Agent tool call detected |
| `prompt:start` | `{ sessionId, prompt }` | Prompt submitted |
| `prompt:chunk` | `{ sessionId, chunk }` | Streaming output chunk |
| `prompt:done` | `{ sessionId, exitCode, cancelled?, error? }` | Prompt completed |
| `swarm:spawned` | `{ agentId, parentSessionId, description, startedAt, worktree? }` | Swarm agent launched |
| `swarm:chunk` | `{ agentId, parentSessionId, chunk }` | Swarm agent output |
| `swarm:done` | `{ agentId, exitCode, cancelled?, description }` | Swarm agent exited |
| `swarm:session-linked` | `{ agentId, parentSessionId, dashboardSessionId, claudeSessionId }` | Swarm agent session created |
| `worktree:ready` | `{ worktree, parentSessionId }` | Worktree branch ready for review |
| `worktree:updated` | `{ worktree, parentSessionId }` | Worktree record updated |
| `worktree:removed` | `{ worktreeId, parentSessionId }` | Worktree discarded |

## Testing

18 test files, 279 tests using `bun:test`.

```bash
# Run all tests
bun test src

# Run a single test file
bun test src/api.test.js
bun test src/routes-crafting.test.js

# Run diff-summary evals (calls real Anthropic API)
ANTHROPIC_API_KEY=sk-... bun run eval:diff-summary
```

Tests use Fastify's `app.inject()` for HTTP testing (no real server needed). Integration tests (`api.test.js`, `routes-*.test.js`) create in-memory SQLite databases and rebuild schema inline to avoid touching `dashboard.db`.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3001` | HTTP/WebSocket listen port |
| `HOST` | `127.0.0.1` | Listen host |
| `ANTHROPIC_API_KEY` | *(unset)* | Required for diff summaries and craft synthesis |
| `DIFF_SUMMARY_MODEL` | `claude-haiku-4-5-20251001` | Model for diff summarization |
| `DASHBOARD_API_KEY` | *(unset)* | When set, all non-GET `/api` requests require `X-Dashboard-Api-Key`, `X-Api-Key`, or `Authorization: Bearer` header |
