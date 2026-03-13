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
import sessionRoutes from "./routes/sessions.js";
import eventRoutes from "./routes/events.js";
import diffRoutes from "./routes/diff.js";
import promptRoutes from "./routes/prompt.js";
import swarmRoutes from "./routes/swarm.js";
import worktreeRoutes from "./routes/worktrees.js";
import architectureRoutes from "./routes/architecture.js";
import diffSummaryRoutes from "./routes/diff-summary.js";
import craftingRoutes from "./routes/crafting.js";

const PORT = process.env.PORT ?? 3001;

const app = Fastify({ logger: true });

await app.register(cors, { origin: true, methods: ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"] });
await app.register(websocket);

const MAX_WS_CLIENTS = 50;

// WebSocket endpoint — sends current state on connect, tracks clients for broadcast
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

// Ping/pong heartbeat — detects and removes half-open connections every 30s
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

app.addHook("onClose", () => {
  clearInterval(heartbeatInterval);
  shutdownWatchers();
  for (const socket of wsClients) {
    socket.close(1001, "Server shutting down");
  }
  wsClients.clear();
});

// Route plugins
await app.register(sessionRoutes);
await app.register(eventRoutes);
await app.register(diffRoutes);
await app.register(promptRoutes);
await app.register(swarmRoutes);
await app.register(worktreeRoutes);
await app.register(architectureRoutes);
await app.register(diffSummaryRoutes);
await app.register(craftingRoutes);

// Clean up any duplicate sessions from prior TOCTOU races in resolveSessionId
deduplicateSessions();

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

app.post("/api/vpn/reconfigure", async () => {
  const result = await reconfigureVpn();
  return { ok: true, ...result };
});

// Start git watchers for active sessions (detects manual commits, branch switches, etc.)
initWatchers(getActiveSessions.all());

// Serve built UI static files if available
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

// Accept empty bodies for content-type: application/json (e.g. the stop hook)
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

// Detect VPN and configure proxy/cert env vars before accepting requests
await configureVpn();

await app.listen({ port: Number(PORT), host: process.env.HOST ?? "127.0.0.1" });
console.log(`Agent Dashboard server running on http://localhost:${PORT}`);
