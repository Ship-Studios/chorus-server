/**
 * @module index
 * @description
 * Entry point for the Agent Dashboard Fastify server.
 *
 * Responsibilities:
 *  1. Create and configure the Fastify app (CORS, WebSocket, static files).
 *  2. Register the WebSocket `/ws` endpoint with client-cap and heartbeat.
 *  3. Register all REST API route plugins (sessions, events, diff, prompt,
 *     swarm, worktrees, architecture, diff-summary, crafting).
 *  4. Expose `/api/health` and `/api/vpn/reconfigure` utility endpoints.
 *  5. Detect VPN state and configure proxy/cert environment before listening.
 *  6. Serve the pre-built SvelteKit UI as static files in production.
 *
 * Startup lifecycle (order matters):
 *   imports → Fastify instance → CORS + WS plugins → WebSocket handler →
 *   heartbeat timer → route registration → session dedup → health/vpn routes →
 *   git watchers → static file serving → empty-body JSON parser →
 *   VPN detection → listen
 *
 * Environment variables:
 *   PORT            — Listen port (default 3001)
 *   HOST            — Listen host (default 127.0.0.1)
 *   FORCE_VPN_MODE  — Skip detection, assume on-VPN
 *   FORCE_OFF_VPN   — Skip detection, assume off-VPN
 *
 * @see {@link ../CLAUDE.md} for full REST API reference, DB schema, and WS protocol.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { wsClients, broadcast } from "./broadcast.js";
import { getAllSessions, getActiveSessions, getRecentEvents, getRecentAgents, getAllActiveWorktrees, deduplicateSessions } from "./db.js";
import { initWatchers, shutdownWatchers } from "./git-watcher.js";
import { configureVpn, reconfigureVpn, vpnState } from "./vpn.js";

// --- Route plugins (each exports a default async Fastify plugin) -----------
import sessionRoutes from "./routes/sessions.js";
import eventRoutes from "./routes/events.js";
import diffRoutes from "./routes/diff.js";
import promptRoutes from "./routes/prompt.js";
import swarmRoutes from "./routes/swarm.js";
import worktreeRoutes from "./routes/worktrees.js";
import architectureRoutes from "./routes/architecture.js";
import diffSummaryRoutes, { resetClient as resetDiffSummaryClient } from "./routes/diff-summary.js";
import craftingRoutes, { resetClient as resetCraftingClient } from "./routes/crafting.js";

/** @type {number} Server listen port, overridable via PORT env var. */
const PORT = process.env.PORT ?? 3001;

// ---------------------------------------------------------------------------
// App instance & core plugins
// ---------------------------------------------------------------------------

const app = Fastify({ logger: true });

await app.register(cors, { origin: true, methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"] });
await app.register(websocket);

/**
 * Hard cap on concurrent WebSocket dashboard clients.
 * New connections beyond this limit are immediately closed with code 1013
 * ("Try Again Later"). Prevents runaway resource consumption if many
 * browser tabs are left open.
 */
const MAX_WS_CLIENTS = 50;

// ---------------------------------------------------------------------------
// WebSocket endpoint
// ---------------------------------------------------------------------------
// On connect: send an `init` message with the full current state (sessions,
// recent events, agents, worktrees) so the UI can hydrate immediately.
// Clients are tracked in the shared `wsClients` Set used by broadcast.js.
// Ping/pong heartbeat (below) garbage-collects half-open connections.

app.register(async (fastify) => {
  fastify.get("/ws", { websocket: true }, (socket) => {
    if (wsClients.size >= MAX_WS_CLIENTS) {
      socket.close(1013, "Too many connections");
      return;
    }
    socket.isAlive = true;
    wsClients.add(socket);
    console.log(`Dashboard client connected (${wsClients.size} total)`);

    socket.on("pong", () => { socket.isAlive = true; });

    try {
      socket.send(JSON.stringify({
        type: "init",
        sessions: getAllSessions.all(),
        recentEvents: getRecentEvents.all(),
        agents: getRecentAgents.all(),
        worktrees: getAllActiveWorktrees.all(),
      }));
    } catch (err) {
      console.error("[ws] failed to send init:", err.message);
    }

    socket.on("error", (err) => {
      console.error("[ws] client error:", err.message);
      wsClients.delete(socket);
    });

    socket.on("close", () => {
      wsClients.delete(socket);
      console.log(`Dashboard client disconnected (${wsClients.size} total)`);
    });
  });
});

// ---------------------------------------------------------------------------
// Heartbeat — detect and cull half-open WebSocket connections
// ---------------------------------------------------------------------------
// Every 30s: any client that didn't respond to the previous ping is terminated.
// This is critical for long-lived dashboard tabs that lose network silently
// (laptop sleep, Wi-Fi roaming, etc.).

const heartbeatInterval = setInterval(() => {
  for (const socket of wsClients) {
    if (!socket.isAlive) {
      console.warn("[ws] terminating unresponsive client (no pong received)");
      wsClients.delete(socket);
      socket.terminate();
      continue;
    }
    socket.isAlive = false;
    socket.ping();
  }
}, 30_000);

/**
 * Graceful shutdown hook — cleans up heartbeat timer, git watchers,
 * and notifies all connected dashboard clients before closing sockets.
 * Code 1001 ("Going Away") tells the browser's reconnect logic that the
 * disconnect was intentional.
 */
app.addHook("onClose", () => {
  clearInterval(heartbeatInterval);
  shutdownWatchers();
  for (const socket of wsClients) {
    socket.close(1001, "Server shutting down");
  }
  wsClients.clear();
});

// ---------------------------------------------------------------------------
// Route plugin registration
// ---------------------------------------------------------------------------
// Each route module in src/routes/ exports a default async Fastify plugin.
// Registration order doesn't affect routing, but grouping keeps the file
// scannable. All routes are prefixed with /api/ by convention inside each plugin.

await app.register(sessionRoutes);    // /api/sessions, /api/hooks/*
await app.register(eventRoutes);      // /api/events
await app.register(diffRoutes);       // /api/sessions/:id/diff
await app.register(promptRoutes);     // /api/sessions/:id/prompt
await app.register(swarmRoutes);      // /api/sessions/:id/swarm, /api/swarm/:agentId
await app.register(worktreeRoutes);   // /api/sessions/:id/worktrees, /api/worktrees/:id
await app.register(architectureRoutes); // /api/sessions/:id/architecture
await app.register(diffSummaryRoutes);  // /api/sessions/:id/diff/summary
await app.register(craftingRoutes);     // /api/craft/*

// Clean up duplicate sessions from prior TOCTOU races in resolveSessionId.
// Safe to run on every startup — idempotent dedup by project_dir.
deduplicateSessions();

// ---------------------------------------------------------------------------
// Utility endpoints (not in separate route files — lightweight, app-level)
// ---------------------------------------------------------------------------

/** GET /api/health — Liveness probe with uptime and VPN diagnostic state. */
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
  resetCraftingClient();
  const result = await reconfigureVpn();
  return { ok: true, ...result };
});

// ---------------------------------------------------------------------------
// Startup tasks
// ---------------------------------------------------------------------------

// Resume git directory watchers for any sessions that were active before a
// server restart. Watches .git/HEAD, .git/index, and .git/refs/ to broadcast
// diff:invalidated when files change outside of Claude Code hooks.
initWatchers(getActiveSessions.all());

// In production (after `bun run build`), serve the SvelteKit SPA from the
// pre-built ui/build directory. The 200.html fallback enables client-side
// routing — all non-API, non-WS paths return the SPA shell.
const __dirname = dirname(fileURLToPath(import.meta.url));
const uiBuildPath = join(__dirname, "../../ui/build");

if (existsSync(uiBuildPath)) {
  await app.register(fastifyStatic, { root: uiBuildPath, prefix: "/", index: "200.html" });

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api/") || req.url.startsWith("/ws")) {
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
// VPN detection MUST run before app.listen() so that proxy/cert env vars are
// set before any outbound HTTP requests (e.g. Anthropic API calls for diff
// summaries or crafting synthesis). See vpn.js for detection logic.

await configureVpn();

await app.listen({ port: Number(PORT), host: process.env.HOST ?? "127.0.0.1" });
console.log(`Agent Dashboard server running on http://localhost:${PORT}`);
