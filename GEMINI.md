# GEMINI.md - Chorus Server

This document provides instructional context for Gemini when working within the `@chorus/server` package.

## Project Overview
The **Chorus Server** is a Fastify 5 backend designed to receive, persist, and broadcast real-time events from the Claude Code CLI. It serves as the central hub for the Chorus ecosystem, managing sessions, git diffs, AI-powered summaries, and agent orchestration.

### Core Technologies
- **Runtime:** [Bun](https://bun.sh/) (used for execution, testing, and SQLite).
- **Web Framework:** [Fastify 5](https://fastify.dev/) (REST API).
- **Real-time:** [Socket.IO](https://socket.io/) (broadcasting updates to the UI).
- **Database:** [SQLite](https://bun.sh/docs/api/sqlite) via `bun:sqlite` (WAL mode, foreign keys enabled).
- **AI Integration:** [Anthropic SDK](https://www.npmjs.com/package/@anthropic-ai/sdk) (Sonnet 3.5/3.7).
- **Utilities:** `chokidar` (git watching), `workspace:*` dependencies (shared diff logic).

## Architecture & Module Map
- **`src/index.js`**: Server entry point. Handles Fastify configuration, route registration, VPN detection, and Socket.IO initialization.
- **`src/db.js`**: Database schema and prepared statements. Uses `$paramName` binding syntax.
- **`src/routes/`**: Feature-scoped Fastify plugins.
    - `sessions.js`: Hook adapters and session CRUD.
    - `events.js`: Event logging and agent detection.
    - `diff.js`: Git diff retrieval and hunk parsing.
    - `prompt.js`: `claude --resume` subprocess management.
    - `worktrees/`: Git worktree lifecycle for isolated agent branches.
- **`src/vpn.js`**: Critical logic for detecting corporate VPNs and configuring `HTTP_PROXY` / `NODE_EXTRA_CA_CERTS` so outbound Anthropic API calls succeed.
- **`src/session-resolver.js`**: Maps ephemeral CLI session IDs to stable dashboard session IDs using a multi-step resolution strategy.

## Building and Running
- **Development:** `bun run dev` (starts `src/index.js` with `--watch`).
- **Testing:** `bun test src` (runs the full suite using `bun:test`).
- **Single Test:** `bun test src/path/to/file.test.js`.
- **Evals:** `bun run eval:diff-summary` (requires `ANTHROPIC_API_KEY`).

## Development Conventions
### Coding Style
- **ESM:** Always use ECMAScript Modules (`import`/`export`).
- **Formatting:** 2-space indentation, double quotes, and semicolons.
- **Documentation:** Use JSDoc headers for modules and complex functions.

### Database Patterns
- Use **prepared statements** exported from `src/db.js`.
- Always use **named parameters** (`$id`, `$projectDir`) rather than positional ones.
- Execute write operations within `runInTransaction(fn)` if multiple steps are involved.

### API & Routes
- Route handlers should be defined as **Fastify plugins** (async functions).
- API routes are prefixed with `/api/` by convention within the plugin registration.
- Use `app.inject()` in tests for full HTTP integration coverage.

### Real-time Updates
- Use `broadcast(payload)` for global events (e.g., `session:updated`).
- Use `broadcastToSession(sessionId, payload)` for session-scoped events (e.g., `prompt:chunk`).

## Security & Environment
- **Secrets:** Never commit `ANTHROPIC_API_KEY` or `DASHBOARD_API_KEY`.
- **In-Memory Testing:** Integration tests should use in-memory SQLite to avoid mutating the production `dashboard.db`.
- **VPN State:** Be aware that proxy settings are applied globally to `process.env` during startup. Use `vpnState` to check connectivity.
