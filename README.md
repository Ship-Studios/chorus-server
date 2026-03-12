# @agent-dashboard/server

Fastify 5 backend for the Agent Dashboard. Receives Claude Code hook events, persists them to SQLite, and streams real-time updates to dashboard clients over WebSocket.

## Installation

This package is part of the `agent-dashboard` monorepo. Install from the repo root:

```bash
bun install
```

## Usage

```bash
# Development (hot reload)
bun --watch src/index.js

# Production (via monorepo root)
bun run start
```

The server starts on `http://localhost:3001` by default.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3001` | Listen port |
| `HOST` | `127.0.0.1` | Listen host |
| `ANTHROPIC_API_KEY` | — | Required for diff summary and crafting synthesis |
| `DASHBOARD_API_KEY` | — | Optional: guards non-GET `/api` routes |
| `MAX_SWARM_AGENTS` | `10` | Max concurrent swarm agent processes |

## API

See the [root CLAUDE.md](../../CLAUDE.md) for full endpoint documentation. Summary:

- **Hook endpoints** — `POST /api/sessions`, `POST /api/events`, `POST /api/sessions/:id/stop`
- **Query endpoints** — `GET /api/sessions`, `GET /api/sessions/:id/events`, `GET /api/sessions/:id/diff`
- **Prompt control** — `POST /api/sessions/:id/prompt`, cancel, status
- **Swarm agents** — `POST /api/sessions/:id/swarm/spawn`, cancel, list
- **Worktree review** — diff, files, merge, discard, conflict check
- **Crafting workbench** — agents and recipes CRUD, AI synthesis
- **WebSocket** — `WS /ws` streams `init`, `event:new`, `session:updated`, `prompt:chunk`, `swarm:*`, `worktree:*`

## Development

```bash
# Run all tests
bun test src

# Run a specific test file
bun test src/api.test.js

# Run diff-summary evals (calls Anthropic API)
ANTHROPIC_API_KEY=sk-... bun run eval:diff-summary
```

## Architecture

```
src/
├── index.js           # Fastify app, WebSocket endpoint, route registration
├── db.js              # SQLite schema (7 tables), all prepared statements
├── session-resolver.js# Session alias resolution with git root LRU cache
├── broadcast.js       # wsClients Set + broadcast() helper
├── stream-parser.js   # Line-buffered JSON parser for claude CLI output
├── prompt.js          # claude --resume subprocess management
├── swarm-manager.js   # Independent swarm agent lifecycle
├── git-worktree.js    # Git worktree create/remove/merge/conflict ops
├── architecture.js    # Async project source tree + import graph scanner
├── git.js             # Re-export bridge → @agent-dashboard/diff-panel
├── run-git.js         # Re-export bridge → @agent-dashboard/diff-panel
├── diff.js            # Re-export bridge → @agent-dashboard/diff-panel
├── summarize-diff.js  # Re-export bridge → @agent-dashboard/diff-panel
├── routes/            # Fastify route plugins (one file per domain)
│   ├── sessions.js
│   ├── events.js
│   ├── diff.js
│   ├── diff-summary.js
│   ├── prompt.js
│   ├── swarm.js
│   ├── worktrees.js
│   ├── architecture.js
│   └── crafting.js
└── evals/             # Anthropic API quality tests (not in bun test suite)
    └── diff-summary.eval.js
```

Diff parsing, git binary resolution, and AI summarization are provided by `@agent-dashboard/diff-panel` (workspace package). The `git.js`, `run-git.js`, `diff.js`, and `summarize-diff.js` modules are thin re-export bridges that keep route import paths stable while the canonical implementations live in the shared package.

The database file `dashboard.db` is created in the package root on first run (not committed to git).
