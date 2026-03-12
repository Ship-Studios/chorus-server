/**
 * Fixture diffs for eval testing.
 *
 * Each fixture represents a realistic diff scenario with:
 *   - name: Human-readable scenario label
 *   - diff: Raw unified diff text (as git would produce)
 *   - stat: Git --stat summary
 *   - expectations: What a good summary SHOULD mention
 *     - mentionsAny: Summary should contain at least one of these strings (case-insensitive)
 *     - nature: The type of change (feature, bugfix, refactor, config, etc.)
 *     - maxWords: Upper bound on word count for this scenario
 *     - conversational: If true, apply additional tone checks for natural language flow
 *
 * When adding new fixtures, model them on real diffs from your project.
 */

export const fixtures = [
  // ── 1. Feature addition: new file + new function ──────────────────────────
  {
    name: "New feature: add authentication middleware",
    diff: `diff --git a/src/middleware/auth.js b/src/middleware/auth.js
new file mode 100644
index 0000000..a1b2c3d
--- /dev/null
+++ b/src/middleware/auth.js
@@ -0,0 +1,32 @@
+import jwt from "jsonwebtoken";
+
+const JWT_SECRET = process.env.JWT_SECRET;
+
+export function requireAuth(req, reply, done) {
+  const token = req.headers.authorization?.replace("Bearer ", "");
+  if (!token) {
+    reply.code(401).send({ error: "Missing authentication token" });
+    return;
+  }
+
+  try {
+    const decoded = jwt.verify(token, JWT_SECRET);
+    req.user = decoded;
+    done();
+  } catch (err) {
+    reply.code(403).send({ error: "Invalid or expired token" });
+  }
+}
+
+export function requireRole(role) {
+  return (req, reply, done) => {
+    if (!req.user || req.user.role !== role) {
+      reply.code(403).send({ error: "Insufficient permissions" });
+      return;
+    }
+    done();
+  };
+}
diff --git a/src/routes/sessions.js b/src/routes/sessions.js
index d4e5f6a..b7c8d9e 100644
--- a/src/routes/sessions.js
+++ b/src/routes/sessions.js
@@ -1,5 +1,6 @@
 import { getAllSessions, getSession } from "../db.js";
+import { requireAuth } from "../middleware/auth.js";

 export default async function sessionRoutes(fastify) {
-  fastify.get("/api/sessions", async () => {
+  fastify.get("/api/sessions", { preHandler: requireAuth }, async () => {
     return getAllSessions.all();`,
    stat: "2 files changed, 34 insertions(+), 1 deletion(-)",
    expectations: {
      mentionsAny: ["auth", "middleware", "jwt", "token", "authentication"],
      nature: "feature",
      maxWords: 150,
    },
  },

  // ── 2. Bug fix: small targeted change ─────────────────────────────────────
  {
    name: "Bug fix: off-by-one error in pagination",
    diff: `diff --git a/src/db.js b/src/db.js
index a1b2c3d..d4e5f6a 100644
--- a/src/db.js
+++ b/src/db.js
@@ -45,7 +45,7 @@ export const getRecentEvents = db.prepare(\`
   SELECT e.*, s.project_dir
   FROM events e
   LEFT JOIN sessions s ON e.session_id = s.id
-  ORDER BY e.created_at DESC LIMIT 100 OFFSET $offset
+  ORDER BY e.created_at DESC LIMIT $limit OFFSET $offset
 \`);

 export const getSessionEvents = db.prepare(\`
@@ -53,7 +53,7 @@ export const getSessionEvents = db.prepare(\`
   SELECT *
   FROM events
   WHERE session_id = $sessionId
-  ORDER BY created_at DESC LIMIT 200
+  ORDER BY created_at DESC LIMIT $limit
 \`);`,
    stat: "1 file changed, 2 insertions(+), 2 deletions(-)",
    expectations: {
      mentionsAny: ["limit", "pagination", "query", "parameteriz", "hardcoded", "offset"],
      nature: "bugfix",
      maxWords: 150,
    },
  },

  // ── 3. Refactoring: extract function ──────────────────────────────────────
  {
    name: "Refactor: extract WebSocket broadcast into utility",
    diff: `diff --git a/src/broadcast.js b/src/broadcast.js
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/broadcast.js
@@ -0,0 +1,12 @@
+export const wsClients = new Set();
+
+export function broadcast(message) {
+  const data = JSON.stringify(message);
+  for (const client of wsClients) {
+    try {
+      client.send(data);
+    } catch {
+      wsClients.delete(client);
+    }
+  }
+}
diff --git a/src/routes/sessions.js b/src/routes/sessions.js
index a1b2c3d..d4e5f6a 100644
--- a/src/routes/sessions.js
+++ b/src/routes/sessions.js
@@ -1,5 +1,5 @@
 import { getAllSessions, upsertSession } from "../db.js";
-import { wsClients } from "../index.js";
+import { broadcast } from "../broadcast.js";

 export default async function sessionRoutes(fastify) {
   fastify.post("/api/sessions", async (req) => {
@@ -10,12 +10,7 @@ export default async function sessionRoutes(fastify) {
     const sessions = getAllSessions.all();

-    const msg = JSON.stringify({ type: "sessions:update", sessions });
-    for (const client of wsClients) {
-      try {
-        client.send(msg);
-      } catch {
-        wsClients.delete(client);
-      }
-    }
+    broadcast({ type: "sessions:update", sessions });

     return { ok: true };
diff --git a/src/routes/events.js b/src/routes/events.js
index b7c8d9e..e0f1a2b 100644
--- a/src/routes/events.js
+++ b/src/routes/events.js
@@ -1,5 +1,5 @@
 import { insertEvent } from "../db.js";
-import { wsClients } from "../index.js";
+import { broadcast } from "../broadcast.js";

 export default async function eventRoutes(fastify) {
   fastify.post("/api/events", async (req) => {
@@ -8,12 +8,7 @@ export default async function eventRoutes(fastify) {
     const event = insertEvent.get({ ... });

-    const msg = JSON.stringify({ type: "event:new", event });
-    for (const client of wsClients) {
-      try {
-        client.send(msg);
-      } catch {
-        wsClients.delete(client);
-      }
-    }
+    broadcast({ type: "event:new", event });

     return { ok: true };`,
    stat: "3 files changed, 17 insertions(+), 22 deletions(-)",
    expectations: {
      mentionsAny: ["broadcast", "extract", "refactor", "websocket", "utility", "deduplic"],
      nature: "refactor",
      maxWords: 150,
    },
  },

  // ── 4. Configuration / dependency change ──────────────────────────────────
  {
    name: "Config: add rate limiting dependency and configuration",
    diff: `diff --git a/package.json b/package.json
index a1b2c3d..d4e5f6a 100644
--- a/package.json
+++ b/package.json
@@ -12,6 +12,7 @@
     "@fastify/cors": "^10.0.0",
+    "@fastify/rate-limit": "^10.2.0",
     "@fastify/websocket": "^11.0.0",
     "fastify": "^5.0.0"
   }
diff --git a/src/index.js b/src/index.js
index b7c8d9e..e0f1a2b 100644
--- a/src/index.js
+++ b/src/index.js
@@ -2,6 +2,7 @@ import Fastify from "fastify";
 import cors from "@fastify/cors";
+import rateLimit from "@fastify/rate-limit";
 import websocket from "@fastify/websocket";

 const app = Fastify({ logger: true });
@@ -9,6 +10,11 @@ const app = Fastify({ logger: true });
 await app.register(cors, { origin: true });
 await app.register(websocket);
+await app.register(rateLimit, {
+  max: 100,
+  timeWindow: "1 minute",
+  keyGenerator: (req) => req.ip,
+});`,
    stat: "2 files changed, 7 insertions(+), 0 deletions(-)",
    expectations: {
      mentionsAny: ["rate limit", "dependency", "100 requests", "throttl"],
      nature: "config",
      maxWords: 150,
    },
  },

  // ── 5. Multi-concern change (test + implementation) ───────────────────────
  {
    name: "Feature + tests: add health check endpoint with tests",
    diff: `diff --git a/src/routes/health.js b/src/routes/health.js
new file mode 100644
index 0000000..abcdef0
--- /dev/null
+++ b/src/routes/health.js
@@ -0,0 +1,18 @@
+import { db } from "../db.js";
+
+export default async function healthRoutes(fastify) {
+  fastify.get("/api/health", async () => {
+    const dbOk = (() => {
+      try {
+        db.prepare("SELECT 1").get();
+        return true;
+      } catch {
+        return false;
+      }
+    })();
+
+    return {
+      status: dbOk ? "ok" : "degraded",
+      uptime: process.uptime(),
+      database: dbOk,
+    };
+  });
+}
diff --git a/src/routes/health.test.js b/src/routes/health.test.js
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/src/routes/health.test.js
@@ -0,0 +1,28 @@
+import { describe, expect, it, beforeAll, afterAll } from "bun:test";
+import Fastify from "fastify";
+
+let app;
+
+beforeAll(async () => {
+  app = Fastify();
+  app.get("/api/health", async () => ({
+    status: "ok",
+    uptime: process.uptime(),
+    database: true,
+  }));
+  await app.ready();
+});
+
+afterAll(() => app?.close());
+
+describe("GET /api/health", () => {
+  it("returns 200 with health info", async () => {
+    const res = await app.inject({ method: "GET", url: "/api/health" });
+    expect(res.statusCode).toBe(200);
+    const body = res.json();
+    expect(body.status).toBe("ok");
+    expect(body.database).toBe(true);
+    expect(typeof body.uptime).toBe("number");
+  });
+});`,
    stat: "2 files changed, 46 insertions(+), 0 deletions(-)",
    expectations: {
      mentionsAny: ["health", "endpoint", "test", "database", "uptime", "monitoring"],
      nature: "feature",
      maxWords: 150,
    },
  },

  // ── 6. Deletion: removing deprecated code ─────────────────────────────────
  {
    name: "Cleanup: remove deprecated legacy API endpoint",
    diff: `diff --git a/src/routes/legacy.js b/src/routes/legacy.js
deleted file mode 100644
index a1b2c3d..0000000
--- a/src/routes/legacy.js
+++ /dev/null
@@ -1,35 +0,0 @@
-import { db } from "../db.js";
-
-/**
- * @deprecated Use /api/sessions instead. Scheduled for removal in v3.0.
- */
-export default async function legacyRoutes(fastify) {
-  // Old session list endpoint — kept for backward compat
-  fastify.get("/api/v1/sessions", async (req, reply) => {
-    const rows = db.prepare("SELECT * FROM sessions ORDER BY last_seen_at DESC LIMIT 50").all();
-    return rows.map((r) => ({
-      id: r.id,
-      dir: r.project_dir,
-      active: r.status === "active",
-      ts: r.last_seen_at,
-    }));
-  });
-
-  // Old event submission
-  fastify.post("/api/v1/events", async (req) => {
-    const { session, tool, data } = req.body;
-    db.prepare("INSERT INTO events (session_id, tool_name, payload) VALUES (?, ?, ?)").run(
-      session,
-      tool,
-      JSON.stringify(data),
-    );
-    return { ok: true };
-  });
-}
diff --git a/src/index.js b/src/index.js
index d4e5f6a..b7c8d9e 100644
--- a/src/index.js
+++ b/src/index.js
@@ -8,7 +8,6 @@ import eventRoutes from "./routes/events.js";
 import diffRoutes from "./routes/diff.js";
-import legacyRoutes from "./routes/legacy.js";

 await app.register(sessionRoutes);
 await app.register(eventRoutes);
 await app.register(diffRoutes);
-await app.register(legacyRoutes);`,
    stat: "2 files changed, 0 insertions(+), 38 deletions(-)",
    expectations: {
      mentionsAny: ["remov", "delet", "legacy", "deprecated", "v1", "cleanup"],
      nature: "cleanup",
      maxWords: 150,
    },
  },

  // ── 7. CSS / UI styling change ────────────────────────────────────────────
  {
    name: "UI: update dark theme colors and spacing",
    diff: `diff --git a/packages/ui/src/app.css b/packages/ui/src/app.css
index a1b2c3d..d4e5f6a 100644
--- a/packages/ui/src/app.css
+++ b/packages/ui/src/app.css
@@ -5,12 +5,12 @@
   --bg-base: #09090b;
-  --bg-card: #18181b;
-  --bg-hover: #27272a;
+  --bg-card: #141416;
+  --bg-hover: #1e1e22;
   --bg-inset: #0f0f11;
   --border: #27272a;
-  --border-muted: #1e1e22;
+  --border-muted: #1a1a1e;
   --text-primary: #fafafa;
   --text-secondary: #a1a1aa;
-  --text-faint: #52525b;
+  --text-faint: #71717a;
 }
diff --git a/packages/ui/src/lib/components/SessionCard.svelte b/packages/ui/src/lib/components/SessionCard.svelte
index b7c8d9e..e0f1a2b 100644
--- a/packages/ui/src/lib/components/SessionCard.svelte
+++ b/packages/ui/src/lib/components/SessionCard.svelte
@@ -45,8 +45,8 @@
   .session-card {
-    padding: 12px 16px;
-    gap: 8px;
+    padding: 14px 18px;
+    gap: 10px;
     border-radius: 8px;
-    border: 1px solid var(--border);
+    border: 1px solid var(--border-muted);
     transition: all 0.15s;
   }`,
    stat: "2 files changed, 6 insertions(+), 6 deletions(-)",
    expectations: {
      mentionsAny: ["theme", "color", "dark", "css", "spacing", "styling", "visual", "ui", "border"],
      nature: "styling",
      maxWords: 150,
    },
  },

  // ── 8. Database migration / schema change ─────────────────────────────────
  {
    name: "Schema: add indexes and new column to events table",
    diff: `diff --git a/src/db.js b/src/db.js
index a1b2c3d..d4e5f6a 100644
--- a/src/db.js
+++ b/src/db.js
@@ -18,7 +18,8 @@ db.exec(\`
       tool_name TEXT,
       file_path TEXT,
       summary TEXT,
-      payload TEXT,
+      payload TEXT DEFAULT NULL,
+      duration_ms INTEGER,
       created_at TEXT NOT NULL DEFAULT (datetime('now'))
     );
     CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
@@ -26,6 +27,8 @@ db.exec(\`
     CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
+    CREATE INDEX IF NOT EXISTS idx_events_tool ON events(tool_name);
+    CREATE INDEX IF NOT EXISTS idx_events_session_tool ON events(session_id, tool_name);
 \`);

 // -- Prepared statements --
@@ -40,8 +43,9 @@ export const insertEvent = db.prepare(\`
-  INSERT INTO events (session_id, type, tool_name, file_path, summary, payload)
-  VALUES ($sessionId, $type, $toolName, $filePath, $summary, $payload)
+  INSERT INTO events (session_id, type, tool_name, file_path, summary, payload, duration_ms)
+  VALUES ($sessionId, $type, $toolName, $filePath, $summary, $payload, $durationMs)
   RETURNING *
 \`);`,
    stat: "1 file changed, 6 insertions(+), 3 deletions(-)",
    expectations: {
      mentionsAny: ["index", "column", "duration", "schema", "events", "database", "performance"],
      nature: "schema",
      maxWords: 150,
    },
  },

  // ── 9. Conversational: complex multi-concern change needing narrative ─────
  {
    name: "Conversational: real-time WebSocket + caching + error recovery",
    diff: `diff --git a/src/ws-client.ts b/src/ws-client.ts
index a1b2c3d..d4e5f6a 100644
--- a/src/ws-client.ts
+++ b/src/ws-client.ts
@@ -1,18 +1,52 @@
-import { writable } from "svelte/store";
+import { writable, get } from "svelte/store";

 export const connected = writable(false);
 export const sessions = writable([]);
+export const reconnectAttempts = writable(0);
+
+const MAX_RECONNECT_DELAY = 30_000;
+const BASE_DELAY = 1_000;

 let ws: WebSocket | null = null;
+let messageCache = new Map<string, { data: any; ts: number }>();

 export function connect(url: string) {
   ws = new WebSocket(url);
+
   ws.onopen = () => {
     connected.set(true);
-    console.log("Connected");
+    reconnectAttempts.set(0);
+    console.log("Connected to dashboard server");
+
+    // Replay any messages that arrived during disconnection
+    if (messageCache.size > 0) {
+      console.log(\`Replaying \${messageCache.size} cached messages\`);
+      for (const [key, entry] of messageCache) {
+        if (Date.now() - entry.ts < 60_000) {
+          handleMessage(entry.data);
+        }
+      }
+      messageCache.clear();
+    }
   };
+
   ws.onclose = () => {
     connected.set(false);
-    setTimeout(() => connect(url), 2000);
+    const attempts = get(reconnectAttempts);
+    const delay = Math.min(BASE_DELAY * Math.pow(2, attempts), MAX_RECONNECT_DELAY);
+    reconnectAttempts.update(n => n + 1);
+    console.log(\`Disconnected — reconnecting in \${delay / 1000}s (attempt \${attempts + 1})\`);
+    setTimeout(() => connect(url), delay);
   };
-  ws.onmessage = (e) => {
-    const msg = JSON.parse(e.data);
-    if (msg.type === "init") sessions.set(msg.sessions);
+
+  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
+
+  ws.onerror = (err) => {
+    console.error("WebSocket error:", err);
+  };
+}
+
+function handleMessage(msg: any) {
+  switch (msg.type) {
+    case "init":
+      sessions.set(msg.sessions);
+      break;
+    case "sessions:update":
+      sessions.set(msg.sessions);
+      break;
+    default:
+      console.warn("Unknown message type:", msg.type);
   };
 }
diff --git a/src/lib/api.ts b/src/lib/api.ts
index b7c8d9e..e0f1a2b 100644
--- a/src/lib/api.ts
+++ b/src/lib/api.ts
@@ -1,8 +1,22 @@
 const API_BASE = import.meta.env.DEV ? "http://localhost:3001" : "";

+const requestCache = new Map<string, { data: any; expires: number }>();
+const CACHE_TTL = 5_000; // 5 seconds
+
+async function cachedFetch(url: string): Promise<any> {
+  const cached = requestCache.get(url);
+  if (cached && Date.now() < cached.expires) {
+    return cached.data;
+  }
+  const res = await fetch(url);
+  if (!res.ok) throw new Error(\`API error: \${res.status}\`);
+  const data = await res.json();
+  requestCache.set(url, { data, expires: Date.now() + CACHE_TTL });
+  return data;
+}
+
 export async function fetchSessionDiff(sessionId: string) {
-  const res = await fetch(\`\${API_BASE}/api/sessions/\${sessionId}/diff\`);
-  if (!res.ok) throw new Error("Failed to fetch diff");
-  return res.json();
+  return cachedFetch(\`\${API_BASE}/api/sessions/\${sessionId}/diff\`);
 }`,
    stat: "2 files changed, 48 insertions(+), 10 deletions(-)",
    expectations: {
      mentionsAny: ["reconnect", "exponential", "backoff", "cache", "websocket", "retry", "resilien"],
      nature: "feature",
      maxWords: 200,
      conversational: true,
    },
  },

  // ── 10. Conversational: security fix with nuanced implications ────────────
  {
    name: "Conversational: SQL injection fix with parameterized queries",
    diff: `diff --git a/src/routes/events.js b/src/routes/events.js
index a1b2c3d..d4e5f6a 100644
--- a/src/routes/events.js
+++ b/src/routes/events.js
@@ -15,14 +15,18 @@ export default async function eventRoutes(fastify) {

   // Search events by tool name
   fastify.get("/api/events/search", async (req, reply) => {
-    const { tool, session } = req.query;
-    if (!tool) return reply.code(400).send({ error: "tool query param required" });
+    const { tool, session, from, to } = req.query;
+    if (!tool) return reply.code(400).send({ error: "tool query parameter required" });

-    // WARNING: This was vulnerable to SQL injection
-    const rows = db.prepare(
-      \`SELECT * FROM events WHERE tool_name = '\${tool}'
-       \${session ? \`AND session_id = '\${session}'\` : ""}
-       ORDER BY created_at DESC LIMIT 100\`
-    ).all();
+    const conditions = ["tool_name = $tool"];
+    const params = { $tool: tool };
+
+    if (session) {
+      conditions.push("session_id = $session");
+      params.$session = session;
+    }
+    if (from) {
+      conditions.push("created_at >= $from");
+      params.$from = from;
+    }
+    if (to) {
+      conditions.push("created_at <= $to");
+      params.$to = to;
+    }
+
+    const rows = db.prepare(
+      \`SELECT * FROM events WHERE \${conditions.join(" AND ")}
+       ORDER BY created_at DESC LIMIT 100\`
+    ).all(params);

     return rows;
   });
diff --git a/src/routes/events.test.js b/src/routes/events.test.js
index b7c8d9e..e0f1a2b 100644
--- a/src/routes/events.test.js
+++ b/src/routes/events.test.js
@@ -42,6 +42,17 @@ describe("GET /api/events/search", () => {
     expect(res.statusCode).toBe(400);
   });

+  it("prevents SQL injection via tool parameter", async () => {
+    const res = await app.inject({
+      method: "GET",
+      url: "/api/events/search?tool=' OR 1=1; --",
+    });
+    // Should return empty results, not all events
+    expect(res.statusCode).toBe(200);
+    const body = res.json();
+    expect(body).toHaveLength(0);
+  });
+
+  it("supports date range filtering", async () => {
+    const res = await app.inject({
+      method: "GET",
+      url: "/api/events/search?tool=Read&from=2024-01-01&to=2024-12-31",
+    });
+    expect(res.statusCode).toBe(200);
+  });
 });`,
    stat: "2 files changed, 30 insertions(+), 8 deletions(-)",
    expectations: {
      mentionsAny: ["sql injection", "parameteriz", "security", "vulnerab", "sanitiz", "prepared statement"],
      nature: "security-fix",
      maxWords: 200,
      conversational: true,
    },
  },

  // ── 11. Conversational: trade-off-heavy performance optimization ──────────
  {
    name: "Conversational: performance optimization with caching trade-offs",
    diff: `diff --git a/src/db.js b/src/db.js
index a1b2c3d..d4e5f6a 100644
--- a/src/db.js
+++ b/src/db.js
@@ -5,6 +5,9 @@ const db = new Database("dashboard.db");
 db.exec("PRAGMA journal_mode = WAL");
 db.exec("PRAGMA foreign_keys = ON");
+db.exec("PRAGMA cache_size = -64000"); // 64MB page cache
+db.exec("PRAGMA mmap_size = 268435456"); // 256MB memory-mapped I/O
+db.exec("PRAGMA synchronous = NORMAL"); // Trade durability for write speed

 // ── Schema ──────────────────────────────────────────────────────────────────
@@ -60,12 +63,28 @@ export const getRecentEvents = db.prepare(\`
   LIMIT $limit
 \`);

+// ── In-memory session cache ─────────────────────────────────────────────────
+const sessionCache = new Map();
+const CACHE_TTL = 10_000; // 10 seconds
+
+export function getCachedSession(id) {
+  const entry = sessionCache.get(id);
+  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.session;
+  sessionCache.delete(id);
+  return null;
+}
+
 export function getSession(id) {
+  const cached = getCachedSession(id);
+  if (cached) return cached;
   const session = getSessionStmt.get({ $id: id });
+  if (session) {
+    sessionCache.set(id, { session, ts: Date.now() });
+  }
   return session;
 }

-// Session alias resolution — called on every request
+// Session alias resolution — called on every request, now with caching
 export function resolveSessionId(claudeSessionId) {
+  // Hot path: check alias cache first
+  const cachedAlias = getCachedSession(\`alias:\${claudeSessionId}\`);
+  if (cachedAlias) return cachedAlias.id;
   const alias = getAlias.get({ $claudeSessionId: claudeSessionId });
   if (alias) {
+    sessionCache.set(\`alias:\${claudeSessionId}\`, { session: { id: alias.dashboard_session_id }, ts: Date.now() });
     return alias.dashboard_session_id;
   }`,
    stat: "1 file changed, 25 insertions(+), 2 deletions(-)",
    expectations: {
      mentionsAny: ["cache", "performance", "pragma", "memory", "wal", "durability", "trade-off", "tradeoff", "speed"],
      nature: "performance",
      maxWords: 200,
      conversational: true,
    },
  },
];
