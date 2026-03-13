# @agent-dashboard/server

Fastify 5 API server for the Agent Dashboard. Receives Claude Code lifecycle hook events, persists them to SQLite, and broadcasts real-time updates to dashboard clients over WebSocket.

## Usage

```bash
# Dev (hot reload)
bun --watch src/index.js

# Production (started automatically by bin/dashboard.js / pulse CLI)
bun src/index.js
```

The server listens on `http://127.0.0.1:3001` by default. Override with `PORT` and `HOST` environment variables.

## API

All REST endpoints are documented in the [root CLAUDE.md](../../CLAUDE.md). Key groups:

- **Hook endpoints** -- `POST /api/sessions`, `POST /api/hooks/*` -- called by Claude Code bash and HTTP hooks
- **Session/event queries** -- `GET /api/sessions`, `GET /api/events`, `GET /api/sessions/:id/diff`
- **Prompt control** -- `POST /api/sessions/:id/prompt{,/cancel,/status}` -- streams `claude --resume` output
- **Swarm agents** -- `POST /api/sessions/:id/swarm/spawn`, `POST /api/swarm/:id/cancel`
- **Worktrees** -- `GET/POST/DELETE /api/worktrees/*` -- git branch review flow
- **AI features** -- `POST /api/sessions/:id/diff/summary`, `POST /api/sessions/:id/commit`, `POST /api/craft/synthesize` -- require `ANTHROPIC_API_KEY`
- **WebSocket** -- `WS /ws` -- real-time push to all dashboard clients

## Development

```bash
# Run all tests
bun test src

# Run one test file
bun test src/routes-crafting.test.js

# Diff summary evals (live Anthropic API)
ANTHROPIC_API_KEY=sk-... bun run eval:diff-summary
```

## Architecture

```
src/
  index.js              Fastify bootstrap, WS /ws handler, plugin registration
  db.js                 bun:sqlite schema (7 tables) + all prepared statements
  session-resolver.js   5-step alias resolution, 200-entry git-root LRU cache
  broadcast.js          shared wsClients Set + broadcast()
  stream-parser.js      Line-buffered JSON parser for claude CLI output
  prompt.js             claude --resume subprocess management, re-exports
  swarm-manager.js      Independent swarm agent lifecycle
  git-worktree.js       Git worktree create/remove/merge/conflict ops
  git-watcher.js        chokidar watchers for .git/, diff:invalidated broadcast
  architecture.js       Async project source tree + import graph (30s cache)
  vpn.js                VPN detection, proxy/cert env, Bun fetch options
  git.js                Re-export bridge -> @agent-dashboard/diff-panel
  run-git.js            Re-export bridge -> @agent-dashboard/diff-panel
  diff.js               Re-export bridge -> @agent-dashboard/diff-panel
  summarize-diff.js     Re-export bridge -> @agent-dashboard/diff-panel
  routes/               Fastify route plugins (one file per domain)
    sessions.js         Session CRUD + stop
    events.js           Event logging + all HTTP hook adapters
    diff.js             git diff HEAD
    diff-summary.js     AI diff summary (SHA-256 cache, 10min TTL)
    commit.js           AI commit message + git commit (submodule cascade)
    prompt.js           claude --resume streaming
    swarm.js            Swarm agent spawn/cancel/list
    worktrees/          list, diff, merge, discard, check-conflicts
    architecture.js     Project source tree + import graph
    crafting.js         Craft agent/recipe CRUD + AI synthesis
    directories.js      ~/Documents/code directory listing
  evals/                Anthropic API quality tests (not in bun test suite)
    diff-summary.eval.js
```

SQLite database lives at `dashboard.db` (next to `src/`, created on first run). WAL mode, foreign keys enforced. No migrations -- schema is `CREATE TABLE IF NOT EXISTS`.

Re-export bridges (`git.js`, `run-git.js`, `diff.js`, `summarize-diff.js`) delegate to `@agent-dashboard/diff-panel/server` for shared git utilities. Route files import through `prompt.js` and `db.js` bridges -- do not import from `swarm-manager.js` or `session-resolver.js` directly.
