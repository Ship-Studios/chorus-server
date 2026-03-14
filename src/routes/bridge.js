/**
 * WebSocket bridge for local MCP server daemons (Chorus project).
 *
 * Local MCP daemons running on users' machines connect to this namespace over
 * Socket.IO (/bridge) and register the project directories they manage. The
 * server can then dispatch tool calls (fs_read, bash_exec, etc.) to the right
 * daemon and await the result, enabling the Agent SDK to interact with the
 * user's local filesystem without direct access.
 *
 * Protocol (daemon → server):
 *   connect     handshake.auth.token must equal DASHBOARD_API_KEY (if set)
 *   register    { projects: string[], mode: "read-only"|"read-write"|"full" }
 *   tool_result { requestId: string, result?: object, error?: string }
 *
 * Protocol (server → daemon):
 *   tool_call   { requestId: string, toolName: string, toolInput: object }
 *
 * WebSocket broadcasts (→ main "/" namespace, UI clients):
 *   bridge:connected    { projects, mode }
 *   bridge:disconnected { projects }
 *
 * @module routes/bridge
 */

import { randomUUID } from "node:crypto";
import { getIO } from "../socket.js";

// ---------------------------------------------------------------------------
// Bridge state
// ---------------------------------------------------------------------------

/**
 * Active connections from local daemons.
 * Keyed by project directory — one socket per project directory.
 * A single socket may be registered under multiple project directories.
 *
 * @type {Map<string, import("socket.io").Socket>}
 */
const bridgeConnections = new Map();

/**
 * In-flight tool call promises.
 * Keyed by requestId — each entry holds the resolve/reject callbacks and the
 * timeout timer so cleanup can happen on daemon disconnect or timeout.
 *
 * @type {Map<string, { resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout> }>}
 */
const pendingToolCalls = new Map();

// ---------------------------------------------------------------------------
// Namespace initialisation (called from index.js after setIO())
// ---------------------------------------------------------------------------

/** @type {import("socket.io").Namespace | null} */
let bridgeNsp = null;

const DASHBOARD_API_KEY = process.env.DASHBOARD_API_KEY;

/**
 * Initialise the /bridge Socket.IO namespace.
 * Must be called after `setIO(io)` in index.js.
 */
export function initBridge() {
  if (bridgeNsp) return;

  const io = getIO();
  if (!io) {
    console.warn("[bridge] getIO() returned null — bridge namespace not created");
    return;
  }

  bridgeNsp = io.of("/bridge");

  // ── Auth middleware ────────────────────────────────────────────────────────
  if (DASHBOARD_API_KEY) {
    bridgeNsp.use((socket, next) => {
      const token = socket.handshake.auth?.token;
      if (token === DASHBOARD_API_KEY) return next();
      next(new Error("Unauthorized — invalid or missing API key"));
    });
  }

  // ── Connection handler ────────────────────────────────────────────────────
  bridgeNsp.on("connection", (socket) => {
    console.log(`[bridge] local daemon connected: ${socket.id}`);

    /** Project directories this socket registered (populated on "register"). */
    let registeredProjects = [];

    // ── register ─────────────────────────────────────────────────────────────
    socket.on("register", ({ projects, mode } = {}) => {
      if (!Array.isArray(projects) || projects.length === 0) {
        console.warn(`[bridge] ${socket.id} sent invalid register payload`);
        return;
      }

      registeredProjects = projects;

      for (const projectDir of projects) {
        bridgeConnections.set(projectDir, socket);
      }

      console.log(
        `[bridge] daemon registered projects (${mode}): ${projects.join(", ")}`
      );

      // Notify UI clients
      io.emit("message", {
        type: "bridge:connected",
        projects,
        mode,
      });
    });

    // ── tool_result ──────────────────────────────────────────────────────────
    socket.on("tool_result", ({ requestId, result, error } = {}) => {
      const pending = pendingToolCalls.get(requestId);
      if (!pending) {
        console.warn(`[bridge] received tool_result for unknown requestId: ${requestId}`);
        return;
      }

      clearTimeout(pending.timer);
      pendingToolCalls.delete(requestId);

      if (error) {
        pending.reject(new Error(error));
      } else {
        pending.resolve(result);
      }
    });

    // ── disconnect ────────────────────────────────────────────────────────────
    socket.on("disconnect", (reason) => {
      console.log(`[bridge] local daemon disconnected (${reason}): ${socket.id}`);

      // Remove all project registrations for this socket
      for (const projectDir of registeredProjects) {
        if (bridgeConnections.get(projectDir) === socket) {
          bridgeConnections.delete(projectDir);
        }
      }

      // Reject any pending tool calls that were bound to this socket
      for (const [requestId, pending] of pendingToolCalls) {
        // We can't cheaply map requestId → socket, so check all pending entries
        // and reject those whose target socket matches.
        // (pendingToolCalls stores no socket ref; reject all if only one daemon
        //  was connected, otherwise we must match by project — keep it simple
        //  and reject everything when a daemon leaves to avoid leaked promises.)
        clearTimeout(pending.timer);
        pendingToolCalls.delete(requestId);
        pending.reject(new Error("Local daemon disconnected before tool call completed"));
      }

      if (registeredProjects.length > 0) {
        io.emit("message", {
          type: "bridge:disconnected",
          projects: registeredProjects,
        });
      }

      registeredProjects = [];
    });
  });

  console.log("[bridge] /bridge namespace ready");
}

// ---------------------------------------------------------------------------
// Exported helpers
// ---------------------------------------------------------------------------

/**
 * Find the bridge socket responsible for the given project directory.
 * Matches by exact path first, then by prefix (for sub-directories).
 *
 * @param {string} projectDir
 * @returns {import("socket.io").Socket | null}
 */
function findBridgeForProject(projectDir) {
  // Exact match
  const exact = bridgeConnections.get(projectDir);
  if (exact) return exact;

  // Prefix match — e.g. registered "/home/user/project" covers "/home/user/project/sub"
  for (const [registeredDir, socket] of bridgeConnections) {
    if (projectDir.startsWith(registeredDir + "/")) {
      return socket;
    }
  }

  return null;
}

/**
 * Execute a tool on the local MCP daemon connected for the given project.
 * Returns a Promise that resolves with the tool result or rejects on error /
 * timeout / daemon disconnect.
 *
 * @param {string} projectDir - Project directory used to route to the right daemon
 * @param {string} toolName   - Tool name (e.g. "fs_read", "bash_exec")
 * @param {object} toolInput  - Tool parameters
 * @param {number} [timeout=30000] - Timeout in ms before the call is rejected
 * @returns {Promise<object>}
 */
export async function executeRemoteTool(projectDir, toolName, toolInput, timeout = 30_000) {
  const socket = findBridgeForProject(projectDir);
  if (!socket) {
    throw new Error(`No local agent connected for ${projectDir}`);
  }

  const requestId = randomUUID();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingToolCalls.delete(requestId);
      reject(new Error(`Tool call timed out after ${timeout}ms`));
    }, timeout);

    pendingToolCalls.set(requestId, { resolve, reject, timer });
    socket.emit("tool_call", { requestId, toolName, toolInput });
  });
}

/**
 * Check whether a local daemon is connected for the given project directory.
 *
 * @param {string} projectDir
 * @returns {boolean}
 */
export function isBridgeConnected(projectDir) {
  return !!findBridgeForProject(projectDir);
}

/**
 * Return a snapshot of all active bridge connections.
 * Deduplicates by socket so each daemon appears once even if registered under
 * multiple project directories.
 *
 * @returns {{ projects: string[], mode: string | null, connectedAt: Date }[]}
 */
export function getBridgeStatus() {
  /** @type {Map<string, { projects: string[], connectedAt: Date }>} */
  const bySocket = new Map();

  for (const [projectDir, socket] of bridgeConnections) {
    const entry = bySocket.get(socket.id);
    if (entry) {
      entry.projects.push(projectDir);
    } else {
      bySocket.set(socket.id, {
        projects: [projectDir],
        // Socket.IO does not expose a connectedAt timestamp; use handshake time
        connectedAt: new Date(socket.handshake.issued ?? Date.now()),
      });
    }
  }

  return Array.from(bySocket.values());
}

// ---------------------------------------------------------------------------
// Fastify plugin (no-op HTTP routes — namespace is pure Socket.IO)
// ---------------------------------------------------------------------------

/**
 * Fastify plugin registration hook.
 * No HTTP routes are added; this file is registered to satisfy the standard
 * route-plugin import pattern used in index.js. The actual work is done via
 * `initBridge()` which index.js calls after `setIO()`.
 *
 * @param {import("fastify").FastifyInstance} _app
 */
export default async function bridgeRoutes(_app) {
  // Nothing to register — bridge lives entirely in the Socket.IO namespace.
}
