# Repository Guidelines

## Project Structure & Module Organization
`src/` contains the server entrypoint and all runtime modules. [`src/index.js`](/Users/d0b01r1/Documents/code/agent-dashboard/packages/server/src/index.js) wires Fastify, WebSocket broadcasting, static UI serving, and route registration. Route plugins live in `src/routes/` and use focused modules such as `db.js`, `prompt.js`, `git-worktree.js`, and `swarm-manager.js`. Tests are colocated in `src/` as `*.test.js`; eval scripts and fixtures live under `src/evals/`.

## Build, Test, and Development Commands
Use Bun from the monorepo root or this package directory.

- `bun run dev` starts the server with file watching against `src/index.js`.
- `bun test src` runs the full `bun:test` suite for this package.
- `bun test src/routes-diff.test.js` runs a single test file during iteration.
- `bun run eval:diff-summary` runs the diff-summary evaluation script; it requires a real `ANTHROPIC_API_KEY`.
- `bun run build` is intentionally a no-op because this package runs plain ESM JavaScript directly on Bun.

## Coding Style & Naming Conventions
Follow the existing style: ESM JavaScript, 2-space indentation, semicolons, and double quotes. Keep modules small and explicit; route handlers are registered as Fastify plugins, typically one file per route area under `src/routes/`. Use descriptive kebab-case filenames such as `diff-summary.js` and mirror them in tests like `routes-diff-summary.test.js`.

## Testing Guidelines
Tests use `bun:test` plus Fastify `app.inject()` for HTTP coverage. Add or update colocated `*.test.js` files whenever behavior changes, especially for routes, diff parsing, SQLite interactions, or WebSocket-related state transitions. There is no published coverage threshold, but changes should preserve the existing broad regression coverage across `src/*.test.js`.

## Commit & Pull Request Guidelines
Recent history uses short conventional subjects such as `fix: ...`, `test: ...`, and `chore: ...`. Keep commits focused and imperative. Pull requests should explain the behavioral change, note any API or schema impact, list the Bun commands used for verification, and include request/response examples when route behavior changes.

## Security & Configuration Tips
Default local settings are `PORT=3001` and `HOST=127.0.0.1`. Keep secrets such as `ANTHROPIC_API_KEY` and `DASHBOARD_API_KEY` out of the repository. Avoid writing tests that mutate the package-level `dashboard.db`; prefer in-memory SQLite setups like the current integration tests.
