import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import Fastify from "fastify";
import { Server as SocketIO } from "socket.io";
import { io as ioClient } from "socket.io-client";

/**
 * End-to-end integration tests for the Socket.IO transport layer.
 *
 * Each test spins up a real Fastify HTTP server with Socket.IO attached,
 * connects real socket.io-client instances, and asserts on messages received
 * over the wire. This covers the transport surface that unit tests (broadcast.test.js)
 * cannot reach: connection handshake, room subscription, and scoped delivery.
 *
 * Intentionally does NOT use the socket.js singleton or broadcast.js — those
 * have their own unit tests. Using server.io directly keeps these tests isolated
 * from global state shared across the test suite.
 */

const MAX_WS_CLIENTS = 50;

/** Build a minimal Fastify+Socket.IO server that mirrors index.js connection handler. */
async function buildTestServer() {
  const app = Fastify({ logger: false });

  // app.server exists after app.ready() — attach Socket.IO before app.listen()
  await app.ready();

  const io = new SocketIO(app.server, {
    cors: { origin: true },
    pingInterval: 30_000,
    pingTimeout: 10_000,
    maxHttpBufferSize: 1_000_000,
  });

  io.on("connection", (socket) => {
    if (io.engine.clientsCount > MAX_WS_CLIENTS) {
      socket.disconnect(true);
      return;
    }

    socket.on("join-session", (sessionId) => {
      for (const room of socket.rooms) {
        if (room !== socket.id) socket.leave(room);
      }
      socket.join(`session:${sessionId}`);
    });

    socket.on("leave-session", (sessionId) => {
      socket.leave(`session:${sessionId}`);
    });
  });

  // Port 0 lets the OS assign a free port
  await app.listen({ port: 0, host: "127.0.0.1" });
  const { port } = app.server.address();
  const url = `http://127.0.0.1:${port}`;

  return { app, io, url };
}

/** Connect a socket.io-client and wait for the "connect" event. */
function connectClient(url) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(url, { transports: ["websocket"] });
    socket.once("connect", () => resolve(socket));
    socket.once("connect_error", reject);
  });
}

/** Collect the next N "message" events from a socket into an array. */
function collectMessages(socket, count) {
  return new Promise((resolve) => {
    const msgs = [];
    socket.on("message", (data) => {
      msgs.push(data);
      if (msgs.length >= count) resolve(msgs);
    });
  });
}

let server;
const openClients = [];

beforeEach(async () => {
  server = await buildTestServer();
});

afterEach(async () => {
  // Disconnect all open client sockets before closing the server
  for (const s of openClients.splice(0)) s.disconnect();
  await new Promise((r) => setTimeout(r, 50));
  await Promise.race([
    new Promise((r) => server.io.close(r)),
    new Promise((r) => setTimeout(r, 1000)),
  ]);
  await server.app.close();
});

describe("Socket.IO transport — connection", () => {
  it("accepts a client connection", async () => {
    const client = await connectClient(server.url);
    openClients.push(client);
    expect(client.connected).toBe(true);
  });

  it("global broadcast reaches connected client", async () => {
    const client = await connectClient(server.url);
    openClients.push(client);

    const received = collectMessages(client, 1);
    server.io.emit("message", { type: "test:global", value: 42 });
    const [msg] = await received;

    expect(msg.type).toBe("test:global");
    expect(msg.value).toBe(42);
  });

  it("global broadcast reaches all connected clients", async () => {
    const c1 = await connectClient(server.url);
    const c2 = await connectClient(server.url);
    openClients.push(c1, c2);

    const p1 = collectMessages(c1, 1);
    const p2 = collectMessages(c2, 1);
    server.io.emit("message", { type: "test:all" });

    const [[m1], [m2]] = await Promise.all([p1, p2]);
    expect(m1.type).toBe("test:all");
    expect(m2.type).toBe("test:all");
  });
});

describe("Socket.IO transport — room management", () => {
  it("join-session routes scoped messages only to that client", async () => {
    const inRoom = await connectClient(server.url);
    const outside = await connectClient(server.url);
    openClients.push(inRoom, outside);

    // Subscribe inRoom client to session "sess-A"
    await new Promise((resolve) => {
      inRoom.emit("join-session", "sess-A");
      setTimeout(resolve, 50); // wait for server to process
    });

    const received = collectMessages(inRoom, 1);

    // Track messages on the outside client (should NOT receive)
    const outsideMessages = [];
    outside.on("message", (d) => outsideMessages.push(d));

    server.io.to("session:sess-A").emit("message", { type: "scoped:message", sessionId: "sess-A" });

    const [msg] = await received;
    await new Promise((r) => setTimeout(r, 100)); // give outside a chance to receive

    expect(msg.type).toBe("scoped:message");
    expect(outsideMessages).toHaveLength(0);
  });

  it("leave-session stops client receiving scoped messages", async () => {
    const client = await connectClient(server.url);
    openClients.push(client);

    // Join then leave
    await new Promise((resolve) => {
      client.emit("join-session", "sess-leave");
      setTimeout(resolve, 50);
    });
    await new Promise((resolve) => {
      client.emit("leave-session", "sess-leave");
      setTimeout(resolve, 50);
    });

    const msgsAfterLeave = [];
    client.on("message", (d) => msgsAfterLeave.push(d));

    server.io.to("session:sess-leave").emit("message", { type: "should:not:arrive" });
    await new Promise((r) => setTimeout(r, 100));

    expect(msgsAfterLeave).toHaveLength(0);
  });

  it("join-session switches rooms (single room at a time)", async () => {
    const client = await connectClient(server.url);
    openClients.push(client);

    // Join sess-1 then sess-2 — the handler leaves all rooms before joining, so sess-1 is dropped
    await new Promise((resolve) => {
      client.emit("join-session", "sess-1");
      setTimeout(resolve, 50);
    });
    await new Promise((resolve) => {
      client.emit("join-session", "sess-2");
      setTimeout(resolve, 50);
    });

    const msgs = [];
    client.on("message", (d) => msgs.push(d));

    server.io.to("session:sess-1").emit("message", { type: "from:sess-1" });
    server.io.to("session:sess-2").emit("message", { type: "from:sess-2" });
    await new Promise((r) => setTimeout(r, 100));

    // Should receive sess-2 only, not sess-1
    expect(msgs.map((m) => m.type)).toEqual(["from:sess-2"]);
  });
});

describe("Socket.IO transport — client cap", () => {
  it("rejects connections once the cap is exceeded", async () => {
    // Build a separate server with a tiny cap of 2 to avoid spawning 50 clients
    const cap = 2;
    const capApp = Fastify({ logger: false });
    await capApp.ready();

    const capIo = new SocketIO(capApp.server, { cors: { origin: true } });

    capIo.on("connection", (socket) => {
      if (capIo.engine.clientsCount > cap) {
        socket.disconnect(true);
        return;
      }
    });

    await capApp.listen({ port: 0, host: "127.0.0.1" });
    const capUrl = `http://127.0.0.1:${capApp.server.address().port}`;

    const capClients = [];
    try {
      // Fill to cap
      const c1 = await connectClient(capUrl);
      const c2 = await connectClient(capUrl);
      capClients.push(c1, c2);
      expect(c1.connected).toBe(true);
      expect(c2.connected).toBe(true);

      // The cap+1 th connection should be disconnected by the server.
      // Register all listeners before connecting to avoid a race where
      // the server disconnects before our "connect" handler runs.
      // Disable reconnection so cleanup doesn't hang on infinite retry loops.
      const extra = ioClient(capUrl, {
        transports: ["websocket"],
        autoConnect: false,
        reconnection: false,
      });
      capClients.push(extra);

      const wasRejected = await new Promise((resolve) => {
        extra.once("disconnect", () => resolve(true));
        extra.once("connect_error", () => resolve(true));
        setTimeout(() => resolve(!extra.connected), 2000);
        extra.connect();
      });

      expect(wasRejected).toBe(true);
    } finally {
      for (const s of capClients) s.disconnect();
      await new Promise((r) => setTimeout(r, 100));
      await Promise.race([
        new Promise((r) => capIo.close(r)),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
      await capApp.close();
    }
  }, 10_000);
});
