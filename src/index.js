/**
 * @module index
 * @description
 * Entry point for the Agent Dashboard Fastify server.
 *
 * Responsibilities:
 *  1. Create and configure the Fastify app (CORS, WebSocket, static files).
 *  2. Register the WebSocket `/ws` endpoint with client-cap and heartbeat.
 *  3. Register all REST API route plugins (sessions, events, diff, prompt,
 *     swarm, worktrees, diff-summary, commit, crafting).
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
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
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
import { getActiveSessions, deduplicateSessions, pruneOldData, reconcileOrphanedSessions, getAllSettings } from "./db-adapter.js";
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
 * @see {@link ./routes/settings.js} — Runtime configuration: API keys, models, preferences.
 * GET/PUT/DELETE /api/settings, GET /api/settings/test-anthropic.
 */
import settingsRoutes from "./routes/settings.js";

/**
 * @see {@link ./routes/directories.js} — Lists directories under ~/Documents/code for sidebar nav.
 * Endpoint: `GET /api/directories` → `{ directories: { name, path }[], basePath }`.
 * Filters hidden (dot-prefixed) directories; sorted alphabetically. Synchronous readdir
 * scoped to `~/Documents/code` — no recursive traversal.
 */
import directoryRoutes from "./routes/directories.js";

/**
 * @see {@link ./routes/bridge.js} — WebSocket bridge for local MCP server daemons.
 * `initBridge()`: Creates the /bridge Socket.IO namespace after setIO() is called.
 * Enables the Agent SDK to dispatch tool calls to local daemons and await results.
 */
import bridgeRoutes, { initBridge } from "./routes/bridge.js";


/** @type {number} Server listen port, overridable via PORT env var. */
const PORT = process.env.PORT ?? 3001;

// ---------------------------------------------------------------------------
// App instance & core plugins
// ---------------------------------------------------------------------------
// Fastify is created with Pino logging enabled. CORS is registered first
// because all subsequent route handlers depend on it. Socket.IO is attached
// later (after app.ready()) since it needs the underlying http.Server.

const app = Fastify({ logger: true });

// CORS origin allowlist — defaults to localhost origins for dev safety.
// Override with CORS_ORIGINS env var (comma-separated) for production deployments.
const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim())
  : ["http://localhost:5173", "http://localhost:3001", "http://localhost:5174"];
await app.register(cors, { origin: corsOrigins, methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"] });

// Security headers — X-Content-Type-Options, X-Frame-Options, HSTS, Referrer-Policy, etc.
// CSP is relaxed to allow inline styles (Tailwind), WebSocket connections, and data: URIs
// for fonts/images. In production behind HTTPS, tighten these further.
await app.register(helmet, {
  contentSecurityPolicy: false, // SPA with inline styles + WS — too many exceptions needed
  crossOriginEmbedderPolicy: false, // Breaks embedded images / fonts from CDNs
});

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

// Global rate limit — generous default, tightened on expensive routes via per-route config.
// Prevents abuse of Anthropic API-calling endpoints when the server is network-exposed.
await app.register(rateLimit, {
  max: 200,          // requests per window
  timeWindow: 60_000, // 1 minute
  allowList: ["127.0.0.1", "::1"], // localhost is exempt from global limit
});

// ---------------------------------------------------------------------------
// Optional API key authentication
// ---------------------------------------------------------------------------
// When DASHBOARD_API_KEY is set, all /api/ endpoints (except health and static
// file serving) require a matching Bearer token. This is opt-in: on localhost
// without the env var, everything works as before. For network deployments,
// set DASHBOARD_API_KEY to lock down destructive endpoints (commit, swarm, etc.).
//
// Hook scripts pass the same token via the Authorization header.

const DASHBOARD_API_KEY = process.env.DASHBOARD_API_KEY;

if (DASHBOARD_API_KEY) {
  app.addHook("onRequest", async (request, reply) => {
    const { url } = request;

    // Exempt: health probe, static UI files, socket.io (handled separately)
    if (url === "/api/health" || !url.startsWith("/api/")) return;

    // Exempt: Claude Code HTTP hook endpoints — these come from localhost and
    // don't support custom auth headers in Claude Code's settings.json config.
    // They are event notifications (heartbeat, tool events), not destructive ops.
    if (url.startsWith("/api/hooks/")) return;

    // Exempt: session registration from hooks (session-start.sh sends auth when
    // DASHBOARD_API_KEY is set, but the HTTP hooks that also call /api/sessions
    // cannot add headers). Allow POST /api/sessions without auth since it's an
    // upsert/heartbeat, not destructive.
    if (url === "/api/sessions" && request.method === "POST") return;

    const authHeader = request.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${DASHBOARD_API_KEY}`) {
      reply.code(401).send({ error: "Unauthorized — set DASHBOARD_API_KEY" });
    }
  });

  app.log.info("API key authentication enabled (DASHBOARD_API_KEY is set)");
}

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
// The explicit process.exit() is required because registering a signal handler
// suppresses the default termination behavior. Without it, the old process
// lingers with the port still bound, causing EADDRINUSE when bun --watch
// restarts the server.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    app.close().then(() => process.exit(0));
  });
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
//   Code intel   — diff, diff-summary, commit
//   Interaction  — prompt (--resume streaming), swarm (independent agents)
//   Isolation    — worktrees (git worktree lifecycle + merge/discard)
//   Creative     — crafting (agent workbench + AI synthesis)

await app.register(sessionRoutes);      // POST/GET/DELETE /api/sessions, POST /api/hooks/*
await app.register(eventRoutes);        // POST/GET        /api/events, GET /api/events/:id, /api/sessions/:id/events
await app.register(diffRoutes);         // GET              /api/sessions/:id/diff
await app.register(promptRoutes);       // POST/GET         /api/sessions/:id/prompt{,/cancel,/status}
await app.register(swarmRoutes);        // POST/GET         /api/sessions/:id/swarm/spawn, /api/swarm/:agentId/cancel
await app.register(worktreeRoutes);     // GET/POST/DELETE  /api/sessions/:id/worktrees, /api/worktrees/:id/{diff,files,merge,check-conflicts}
await app.register(diffSummaryRoutes);  // POST/GET         /api/sessions/:id/diff/summary, /api/diff-summary/status
await app.register(commitRoutes);       // POST             /api/sessions/:id/commit
await app.register(craftingRoutes);     // GET/POST/PUT/DELETE /api/craft/{agents,recipes}, POST /api/craft/synthesize
await app.register(settingsRoutes);     // GET/PUT/DELETE /api/settings, GET /api/settings/test-anthropic
await app.register(directoryRoutes);   // GET              /api/directories
await app.register(bridgeRoutes);      // Socket.IO /bridge namespace (no HTTP routes)

/**
 * Clean up duplicate sessions from prior TOCTOU races in resolveSessionId().
 * This can happen when two hooks fire simultaneously for the same project_dir
 * and both create new sessions before seeing the other's row. Safe to run on
 * every startup — idempotent dedup that keeps the most recently seen session.
 */
await deduplicateSessions();

// Load DB settings into process.env (env vars take precedence)
try {
  const dbSettings = await getAllSettings();
  let loaded = 0;
  for (const { key, value } of dbSettings) {
    if (!process.env[key]) {
      process.env[key] = value;
      loaded++;
    }
  }
  if (loaded > 0) app.log.info(`[settings] Loaded ${loaded} setting(s) from database`);
} catch (err) {
  app.log.warn(`[settings] Failed to load settings: ${err.message}`);
}

// Orphan reconciliation — mark active sessions as stopped if they haven't
// been seen in 30 minutes (likely orphaned by a prior server crash).
const orphaned = await reconcileOrphanedSessions();
if (orphaned > 0) {
  app.log.info(`[startup] Marked ${orphaned} orphaned session(s) as stopped`);
}

// Data retention — prune old events/sessions on startup and every 24 hours.
// Configurable via DATA_RETENTION_DAYS env var (default: 30 days).
try {
  const pruned = await pruneOldData();
  if (pruned.eventsDeleted || pruned.sessionsDeleted) {
    app.log.info(`[retention] Pruned ${pruned.eventsDeleted} events, ${pruned.sessionsDeleted} sessions`);
  }
} catch (err) {
  app.log.warn(`[retention] Startup prune failed: ${err.message}`);
}
setInterval(() => {
  try { pruneOldData(); } catch { /* non-critical */ }
}, 24 * 60 * 60 * 1000); // 24 hours

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
initWatchers(await getActiveSessions());

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
  cors: { origin: corsOrigins },
  pingInterval: 30_000,
  pingTimeout: 10_000,
  maxHttpBufferSize: 1_000_000,
});
setIO(io);

// Initialise the /bridge namespace for local MCP daemon connections.
// Must be called after setIO() so getIO() returns the live instance.
initBridge();

// Socket.IO auth middleware — reject unauthenticated connections when API key is set.
if (DASHBOARD_API_KEY) {
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (token === DASHBOARD_API_KEY) return next();
    next(new Error("Unauthorized — invalid or missing API key"));
  });
}

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
console.log(`Agent Dashboard server running on http://${HOST}:${PORT}`);
