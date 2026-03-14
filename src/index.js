/**
 * @module index
 * @description
 * Entry point for the Agent Dashboard Fastify server.
 *
 * Responsibilities:
 *  1. Create and configure the Fastify app (CORS, WebSocket, static files).
 *  2. Register the WebSocket `/ws` endpoint with client-cap and heartbeat.
 *  3. Register all REST API route plugins (sessions, events, diff, prompt,
 *     swarm, worktrees, architecture, diff-summary, commit, crafting).
 *  4. Expose `/api/health` and `/api/vpn/reconfigure` utility endpoints.
 *  5. Detect VPN state and configure proxy/cert environment before listening.
 *  6. Serve the pre-built SvelteKit UI as static files in production.
 *
 * Startup lifecycle (order matters):
 *   imports → Fastify instance → CORS plugin → route registration →
 *   session dedup → health/vpn routes → git watchers → static file serving →
 *   empty-body JSON parser → VPN detection → app.ready() → Socket.IO init →
 *   listen
 *
 * Environment variables:
 *   PORT            — Listen port (default 3001)
 *   HOST            — Listen host (default 127.0.0.1)
 *   FORCE_VPN_MODE  — Skip detection, assume on-VPN
 *   FORCE_OFF_VPN   — Skip detection, assume off-VPN
 *
 * @see {@link ../CLAUDE.md} for full REST API reference, DB schema, and WS protocol.
 */

// ---------------------------------------------------------------------------
// External dependencies
// ---------------------------------------------------------------------------

import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import compress from "@fastify/compress";
import underPressure from "@fastify/under-pressure";
import etag from "@fastify/etag";
import { Server as SocketIO } from "socket.io";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Internal modules
// ---------------------------------------------------------------------------

/**
 * Broadcast utilities for Socket.IO.
 * - `broadcast(msg)`: Emits to all connected clients (global events).
 * - `broadcastToSession(sessionId, msg)`: Emits to clients in a session room.
 */
import { clearDiffTimers } from "./broadcast.js";
import { setIO } from "./socket.js";

/**
 * Database access — prepared statements and session management.
 * All prepared statements are named exports (e.g. `getAllSessions`, `getRecentEvents`).
 * Uses `bun:sqlite` in WAL mode with `$paramName` binding syntax.
 * `deduplicateSessions()` cleans up TOCTOU race duplicates from `resolveSessionId()`.
 */
import { getActiveSessions, deduplicateSessions } from "./db.js";
import { getDashboardSnapshot } from "./dashboard-snapshot.js";

/**
 * Git directory watchers (chokidar).
 * - `initWatchers(sessions)`: Starts watching `.git/HEAD`, `.git/index`, `.git/refs/`
 *   for each active session's `project_dir`. Broadcasts `diff:invalidated` on changes
 *   (300ms debounce) so the UI auto-refreshes diffs.
 * - `shutdownWatchers()`: Closes all watchers during graceful shutdown.
 */
import { initWatchers, shutdownWatchers } from "./git-watcher.js";

/**
 * VPN detection and proxy/certificate environment configuration.
 * - `configureVpn()`: Runs at startup before `app.listen()`. Probes internal
 *   endpoints to detect VPN, then sets `HTTP_PROXY`, `HTTPS_PROXY`,
 *   `NODE_EXTRA_CA_CERTS`, and `NO_PROXY` on `process.env`.
 * - `reconfigureVpn()`: Live re-detection for mid-session VPN toggling.
 * - `vpnState`: Exported singleton with current detection results.
 *
 * Supports override env vars: `FORCE_VPN_MODE`, `FORCE_OFF_VPN`,
 * `VPN_DETECTION_TIMEOUT`, `WALMART_CERT_PATH`.
 */
import { configureVpn, reconfigureVpn, vpnState } from "./vpn.js";

// ---------------------------------------------------------------------------
// Route plugins
// ---------------------------------------------------------------------------
// Each route module exports a default async Fastify plugin function.
// Plugins self-register their routes under `/api/` — no prefix is applied here.
//
// Some route modules also export a `resetClient` function. These invalidate
// cached Anthropic SDK clients so that VPN proxy/TLS changes (via
// `POST /api/vpn/reconfigure`) take effect without a server restart.

/** @see {@link ./routes/sessions.js} — Session CRUD, hook adapters (pre-tool-use, post-tool-use, stop). */
import sessionRoutes from "./routes/sessions.js";

/** @see {@link ./routes/events.js} — Event logging, querying, and agent auto-detection. */
import eventRoutes from "./routes/events.js";

/** @see {@link ./routes/diff.js} — Git diff retrieval with parsed file hunks for the diff viewer. */
import diffRoutes from "./routes/diff.js";

/** @see {@link ./routes/prompt.js} — Prompt submission via `claude --resume`, streaming, cancellation. */
import promptRoutes from "./routes/prompt.js";

/** @see {@link ./routes/swarm.js} — Swarm agent spawning, cancellation, and listing. */
import swarmRoutes from "./routes/swarm.js";

/**
 * @see {@link ./routes/worktrees/index.js} — Git worktree lifecycle: list, diff, merge, discard,
 * conflict detection. Worktrees enable isolated agent branches that don't affect the main tree.
 */
import worktreeRoutes from "./routes/worktrees/index.js";

/** @see {@link ./routes/architecture.js} — Project source tree + import graph scanning (30s cache). */
import architectureRoutes from "./routes/architecture.js";

/**
 * @see {@link ./routes/diff-summary.js} — AI-generated diff summaries via Anthropic API.
 * `resetClient`: Invalidates the cached Anthropic client (for VPN reconfiguration).
 * Uses SHA-256 cache with 60s TTL and 100-entry cap.
 */
import diffSummaryRoutes, { resetClient as resetDiffSummaryClient } from "./routes/diff-summary.js";

/**
 * @see {@link ./routes/commit.js} — AI-powered commit message generation.
 * `resetClient`: Invalidates the cached Anthropic client (for VPN reconfiguration).
 */
import commitRoutes, { resetClient as resetCommitClient } from "./routes/commit.js";

/**
 * @see {@link ./routes/crafting.js} — Minecraft-style agent crafting: agents, recipes, AI synthesis.
 * `resetClient`: Invalidates the cached Anthropic client (for VPN reconfiguration).
 * Synthesis uses `claude-sonnet-4-6`. Model param validated via regex.
 */
import craftingRoutes, { resetClient as resetCraftingClient } from "./routes/crafting.js";

/**
 * @see {@link ./routes/directories.js} — Lists directories under ~/Documents/code for sidebar nav.
 * Endpoint: `GET /api/directories` → `{ directories: { name, path }[], basePath }`.
 * Filters hidden (dot-prefixed) directories; sorted alphabetically. Synchronous readdir
 * scoped to `~/Documents/code` — no recursive traversal.
 */
import directoryRoutes from "./routes/directories.js";

/**
 * @see {@link ./routes/flint.js} — Mobey MCP proxy + AI executive assistant.
 * Endpoints: GET /api/flint/status, /api/flint/ai-status, /api/flint/todos,
 *             /api/flint/boards, POST /api/flint/chat (SSE streaming).
 * Requires `MOBEY_API_KEY`; chat also requires `ANTHROPIC_API_KEY`.
 * `resetClient`: Invalidates the cached Anthropic client (for VPN reconfiguration).
 */
import flintRoutes, { resetClient as resetFlintClient } from "./routes/flint.js";

/** @type {number} Server listen port, overridable via PORT env var. */
const PORT = process.env.PORT ?? 3001;

// ---------------------------------------------------------------------------
// App instance & core plugins
// ---------------------------------------------------------------------------
// Fastify is created with Pino logging enabled. CORS is registered first
// because all subsequent route handlers depend on it. Socket.IO is attached
// later (after app.ready()) since it needs the underlying http.Server.

const app = Fastify({ logger: true });

await app.register(cors, { origin: true, methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"] });

// Brotli/gzip compression for large GET responses (diff payloads, event lists).
// Skip compression below 1KB — hook ACKs and small JSON don't benefit.
await app.register(compress, { global: true, threshold: 1024, encodings: ["br", "gzip", "deflate"] });

// ETags for GET endpoints — enables 304 Not Modified for the UI's 5s polling loop.
// The browser sends If-None-Match; if content hasn't changed, no JSON is transferred.
await app.register(etag);

// Event loop pressure monitor — returns HTTP 503 when the server is overloaded.
// Prevents WebSocket broadcast stalls during hook ingestion bursts.
await app.register(underPressure, {
  maxEventLoopDelay: 1000,
  maxHeapUsedBytes: 500_000_000,
  message: "Server under pressure",
  retryAfter: 50,
});

/**
 * Hard cap on concurrent Socket.IO dashboard clients.
 * New connections beyond this limit are immediately disconnected.
 * Prevents runaway resource consumption if many browser tabs are left open.
 */
const MAX_WS_CLIENTS = 50;

// Socket.IO instance — created later after app.ready(), stored here for
// the shutdown hook to reference.
let io;

/**
 * Graceful shutdown hook — cleans up Socket.IO, diff debounce timers,
 * and git directory watchers.
 */
app.addHook("onClose", () => {
  clearDiffTimers();
  shutdownWatchers();
  if (io) io.close();
});

// Graceful shutdown on signals — ensures onClose hook fires, cleaning up
// heartbeat timer, diff debounce timers, git watchers, and WS connections.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => app.close());
}

// ---------------------------------------------------------------------------
// Route plugin registration
// ---------------------------------------------------------------------------
// Each route module in src/routes/ exports a default async Fastify plugin.
// Registration order doesn't affect routing (Fastify uses radix-tree matching),
// but grouping keeps the file scannable. All routes are prefixed with /api/
// by convention inside each plugin.
//
// Route groups:
//   Core data    — sessions, events (hook adapters, CRUD, queries)
//   Code intel   — diff, architecture, diff-summary, commit
//   Interaction  — prompt (--resume streaming), swarm (independent agents)
//   Isolation    — worktrees (git worktree lifecycle + merge/discard)
//   Creative     — crafting (agent workbench + AI synthesis)

await app.register(sessionRoutes);      // POST/GET/DELETE /api/sessions, POST /api/hooks/*
await app.register(eventRoutes);        // POST/GET        /api/events, GET /api/events/:id, /api/sessions/:id/events
await app.register(diffRoutes);         // GET              /api/sessions/:id/diff
await app.register(promptRoutes);       // POST/GET         /api/sessions/:id/prompt{,/cancel,/status}
await app.register(swarmRoutes);        // POST/GET         /api/sessions/:id/swarm/spawn, /api/swarm/:agentId/cancel
await app.register(worktreeRoutes);     // GET/POST/DELETE  /api/sessions/:id/worktrees, /api/worktrees/:id/{diff,files,merge,check-conflicts}
await app.register(architectureRoutes); // GET              /api/sessions/:id/architecture
await app.register(diffSummaryRoutes);  // POST/GET         /api/sessions/:id/diff/summary, /api/diff-summary/status
await app.register(commitRoutes);       // POST             /api/sessions/:id/commit
await app.register(craftingRoutes);     // GET/POST/PUT/DELETE /api/craft/{agents,recipes}, POST /api/craft/synthesize
await app.register(directoryRoutes);   // GET              /api/directories
await app.register(flintRoutes);       // GET              /api/flint/status, /api/flint/todos

/**
 * Clean up duplicate sessions from prior TOCTOU races in resolveSessionId().
 * This can happen when two hooks fire simultaneously for the same project_dir
 * and both create new sessions before seeing the other's row. Safe to run on
 * every startup — idempotent dedup that keeps the most recently seen session.
 */
deduplicateSessions();

// ---------------------------------------------------------------------------
// Utility endpoints (not in separate route files — lightweight, app-level)
// ---------------------------------------------------------------------------

/**
 * GET /api/health — Liveness probe with uptime and VPN diagnostic state.
 *
 * Returns a JSON object with:
 *   - `status`: Always `"ok"` if the server is reachable.
 *   - `uptime`: Server process uptime in seconds (from `process.uptime()`).
 *   - `vpn`: Full VPN detection state for diagnostics — whether VPN was
 *     detected or forced, active proxy URL, certificate path/validity,
 *     OAuth proxy status, and timestamp of the last detection check.
 *
 * Used by the UI connection banner and external monitoring.
 */
app.get("/api/health", async () => ({
  status: "ok",
  uptime: process.uptime(),
  vpn: {
    detected: vpnState.detected,
    forced: vpnState.forced,
    proxy: vpnState.proxy,
    certPath: vpnState.certPath,
    certValid: vpnState.certValid,
    oauthLoaded: vpnState.oauthLoaded,
    lastCheck: vpnState.lastCheck,
  },
}));

/**
 * POST /api/vpn/reconfigure — Re-detect VPN and reconfigure proxy/cert env.
 * Also invalidates cached Anthropic SDK clients in diff-summary and crafting
 * routes so they pick up the new proxy/TLS settings on their next request.
 * Useful when toggling VPN mid-session without restarting the server.
 */
app.post("/api/vpn/reconfigure", async () => {
  resetDiffSummaryClient();
  resetCommitClient();
  resetCraftingClient();
  resetFlintClient();
  const result = await reconfigureVpn();
  return { ok: true, ...result };
});

// ---------------------------------------------------------------------------
// Startup tasks
// ---------------------------------------------------------------------------

/**
 * Resume git directory watchers for sessions that were active before a server
 * restart. Each watcher monitors `.git/HEAD`, `.git/index`, and `.git/refs/`
 * for changes (via chokidar with 300ms debounce) and broadcasts
 * `diff:invalidated` over WebSocket so the UI auto-refreshes diffs — even
 * when changes come from outside Claude Code hooks (e.g. manual `git commit`).
 */
initWatchers(getActiveSessions.all());

/**
 * Static file serving for the production SvelteKit SPA.
 *
 * After `bun run build`, the UI is compiled to `packages/ui/build/`.
 * This block only activates when that directory exists (skipped in dev mode,
 * where Vite serves the UI on port 5173 instead).
 *
 * The `200.html` file is used as both the index and the not-found fallback,
 * enabling SvelteKit's client-side routing: any non-API, non-WS path returns
 * the SPA shell, and the client router handles the URL. API and WS paths
 * that don't match a route still get a proper 404 JSON response.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const uiBuildPath = join(__dirname, "../../ui/build");

if (existsSync(uiBuildPath)) {
  await app.register(fastifyStatic, { root: uiBuildPath, prefix: "/", index: "200.html" });

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api/") || req.url.startsWith("/ws") || req.url.startsWith("/socket.io/")) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.sendFile("200.html");
  });
}

// ---------------------------------------------------------------------------
// Custom JSON body parser
// ---------------------------------------------------------------------------
// Overrides Fastify's default JSON parser to tolerate empty request bodies.
// The Stop HTTP hook sends a POST with Content-Type: application/json but no
// body. Without this, Fastify would reject those requests with a 400 parse
// error. For non-empty bodies, behavior is identical to the default parser.

app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
  if (!body || body.length === 0) {
    done(null, {});
    return;
  }
  try {
    done(null, JSON.parse(body));
  } catch (err) {
    done(err, undefined);
  }
});

// ---------------------------------------------------------------------------
// VPN detection & listen
// ---------------------------------------------------------------------------
// VPN detection MUST run before app.listen() so that proxy/cert env vars
// (`HTTP_PROXY`, `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `NO_PROXY`) are set
// before any outbound HTTP requests. This matters because:
//   1. Anthropic API calls (diff summaries, commit messages, crafting synthesis)
//      need the proxy to reach external endpoints when on corporate VPN.
//   2. TLS certificate validation requires the custom CA cert on-VPN.
//   3. `NO_PROXY` ensures localhost traffic (hook callbacks) bypasses the proxy.
//
// Override with FORCE_VPN_MODE or FORCE_OFF_VPN to skip auto-detection.
// See vpn.js for the full detection and configuration logic.

await configureVpn();

// ---------------------------------------------------------------------------
// Socket.IO initialization
// ---------------------------------------------------------------------------
// Socket.IO attaches to the underlying http.Server created by Fastify.
// We must call app.ready() first to finalize the route tree, then create the
// Socket.IO server before calling app.listen() to bind the port.
//
// Socket.IO handles heartbeat (pingInterval/pingTimeout) and backpressure
// natively, replacing the manual ping/pong and bufferedAmount checks that
// the old @fastify/websocket setup required.

await app.ready();

io = new SocketIO(app.server, {
  cors: { origin: true },
  pingInterval: 30_000,
  pingTimeout: 10_000,
  maxHttpBufferSize: 1_000_000,
});
setIO(io);

io.on("connection", (socket) => {
  if (io.engine.clientsCount > MAX_WS_CLIENTS) {
    console.warn("[ws] rejecting client — at capacity");
    socket.disconnect(true);
    return;
  }

  console.log(`Dashboard client connected (${io.engine.clientsCount} total)`);

  // Hydrate the client with full current state
  getDashboardSnapshot()
    .then((snapshot) => {
      socket.emit("message", {
        type: "init",
        ...snapshot,
      });
    })
    .catch((err) => {
      console.error("[ws] failed to send init:", err.message);
    });

  // Room management — clients join a session room to receive scoped messages
  socket.on("join-session", (sessionId) => {
    // Leave any previous session rooms (socket.id is always in socket.rooms)
    for (const room of socket.rooms) {
      if (room !== socket.id) socket.leave(room);
    }
    socket.join(`session:${sessionId}`);
  });

  socket.on("leave-session", (sessionId) => {
    socket.leave(`session:${sessionId}`);
  });

  socket.on("disconnect", () => {
    console.log(`Dashboard client disconnected (${io.engine.clientsCount} total)`);
  });
});

/** @type {string} Resolved listen host, defaults to localhost for security. */
const HOST = process.env.HOST ?? "127.0.0.1";

await app.listen({ port: Number(PORT), host: HOST });
console.log(`Agent Dashboard server running on http://localhost:${PORT}`);
