/**
 * WebSocket bridge for local MCP server daemons (Chorus project).
 *
 * Local MCP daemons running on users' machines connect to this namespace over
 * Socket.IO (/bridge) and register the project directories they manage. The
 * server can then dispatch tool calls (fs_read, bash_exec, etc.) to the right
 * daemon and await the result, enabling the Agent SDK to interact with the
 * user's local filesystem without direct access.
 *
 * The bridge also relays prompt lifecycle events between daemons and UI clients.
 * When the Agent SDK runs on the local-agent rather than the server, the server
 * acts as a relay — dispatching prompt_start to the daemon and forwarding
 * chunk/done events back to the UI.
 *
 * Protocol (daemon -> server):
 *   connect       handshake.auth.token must equal DASHBOARD_API_KEY (if set)
 *   register      { projects: string[], mode: "read-only"|"read-write"|"full" }
 *   tool_result   { requestId: string, result?: object, error?: string }
 *   prompt_chunk  { instanceId: string, sessionId: string, chunk: object }
 *   prompt_done   { instanceId: string, sessionId: string, exitCode, error?, cancelled?, worktreeStats?, description? }
 *
 * Protocol (server -> daemon):
 *   tool_call     { requestId: string, toolName: string, toolInput: object }
 *   prompt_start  { instanceId: string, sessionId: string, prompt: string, cwd: string, permissionMode?: string, model?: string, image?: object }
 *   prompt_cancel { instanceId: string }
 *
 * WebSocket broadcasts (-> main "/" namespace, UI clients):
 *   bridge:connected    { projects, mode }
 *   bridge:disconnected { projects }
 *
 * @module routes/bridge
 */

import { randomUUID } from "node:crypto";
import { getIO } from "../socket.js";
import { broadcastToSession, debouncedDiffInvalidation } from "../broadcast.js";
import {
  insertWorktree,
  updateWorktreeStats,
  updateWorktreeConflicts,
  getWorktree,
  updateSessionClaudeId,
} from "../db-adapter.js";
import { invalidateDashboardSnapshot } from "../dashboard-snapshot.js";
import { invalidateDiscoveredWorktrees } from "../worktree-discovery.js";

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

/**
 * Active bridge-relayed prompts.
 * Keyed by instanceId — tracks which session the prompt belongs to so we can
 * clean up on daemon disconnect or timeout.
 *
 * `lastActivity` is updated on every `prompt_chunk` so the timeout is
 * activity-based rather than wall-clock: a long-running agent that streams
 * actively won't be killed.
 *
 * @type {Map<string, { sessionId: string, startedAt: number, lastActivity: number, socket: import("socket.io").Socket, imagePath?: string, timeoutTimer?: ReturnType<typeof setTimeout> }>}
 */
const activeBridgePrompts = new Map();

/** How long (ms) a bridge prompt may be silent before we emit a synthetic error. */
const BRIDGE_PROMPT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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

    // ── prompt_chunk ─────────────────────────────────────────────────────────
    socket.on("prompt_chunk", ({ instanceId, sessionId, chunk } = {}) => {
      if (!sessionId || !chunk) return;

      // Update activity timestamp and reset timeout — the daemon is alive
      if (instanceId) {
        const entry = activeBridgePrompts.get(instanceId);
        if (entry) {
          entry.lastActivity = Date.now();
          resetPromptTimeout(instanceId, entry);
        }
      }

      broadcastToSession(sessionId, { type: "prompt:chunk", sessionId, instanceId, chunk });
    });

    // ── prompt_done ──────────────────────────────────────────────────────────
    socket.on("prompt_done", async ({ instanceId, sessionId, exitCode, error, cancelled, freshSession, worktreeStats, description, sdkSessionId } = {}) => {
      if (!sessionId) return;

      // Persist the Agent SDK session ID for future resume — fire-and-forget,
      // it's only needed on the next prompt so it doesn't block the done broadcast.
      if (sdkSessionId && !cancelled && !error) {
        updateSessionClaudeId(sessionId, sdkSessionId).catch((err) =>
          console.error(`[bridge] failed to update claude session ID for ${sessionId}:`, err.message),
        );
      }

      // If the prompt produced worktree stats, persist to DB
      if (worktreeStats) {
        try {
          const wt = worktreeStats;
          const status = wt.filesChanged > 0 ? "ready" : "empty";

          const { id: worktreeDbId } = await insertWorktree({
            sessionId,
            branchName: wt.branchName,
            baseBranch: wt.baseBranch,
            description: description || "",
            agentId: instanceId,
            status,
          });

          await updateWorktreeStats(worktreeDbId, {
            filesChanged: wt.filesChanged,
            insertions: wt.insertions,
            deletions: wt.deletions,
            diffStat: wt.diffStat,
            status,
          });

          if (wt.conflictInfo) {
            await updateWorktreeConflicts(worktreeDbId, wt.conflictInfo);
          }

          invalidateDiscoveredWorktrees(wt.projectDir || sessionId);
          invalidateDashboardSnapshot();
          const worktreeRow = await getWorktree(worktreeDbId);
          broadcastToSession(sessionId, { type: "worktree:ready", worktree: worktreeRow, parentSessionId: sessionId });
        } catch (err) {
          console.error(`[bridge] failed to persist worktree for instance ${instanceId}:`, err);
        }
      }

      broadcastToSession(sessionId, {
        type: "prompt:done",
        sessionId,
        instanceId,
        exitCode: exitCode ?? null,
        cancelled: cancelled || false,
        error: error || undefined,
        freshSession: freshSession || false,
      });

      debouncedDiffInvalidation(sessionId);

      // Clean up tracking state, timeout timer, and temp image
      if (instanceId) {
        const entry = activeBridgePrompts.get(instanceId);
        if (entry) {
          if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
          if (entry.imagePath) {
            import("node:fs/promises").then(({ unlink }) => unlink(entry.imagePath).catch(() => {}));
          }
        }
        activeBridgePrompts.delete(instanceId);
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
        // We can't cheaply map requestId -> socket, so check all pending entries
        // and reject those whose target socket matches.
        // (pendingToolCalls stores no socket ref; reject all if only one daemon
        //  was connected, otherwise we must match by project — keep it simple
        //  and reject everything when a daemon leaves to avoid leaked promises.)
        clearTimeout(pending.timer);
        pendingToolCalls.delete(requestId);
        pending.reject(new Error("Local daemon disconnected before tool call completed"));
      }

      // Notify UI about orphaned bridge prompts from this socket
      for (const [instanceId, entry] of activeBridgePrompts) {
        if (entry.socket === socket) {
          if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
          console.warn(`[bridge] orphaned prompt ${instanceId} for session ${entry.sessionId} — daemon disconnected after ${Math.round((Date.now() - entry.startedAt) / 1000)}s`);
          broadcastToSession(entry.sessionId, {
            type: "prompt:done",
            sessionId: entry.sessionId,
            instanceId,
            exitCode: null,
            error: "Local agent disconnected",
            cancelled: false,
            freshSession: false,
          });
          activeBridgePrompts.delete(instanceId);
        }
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
// Prompt relay — dispatch to daemon and track active operations
// ---------------------------------------------------------------------------

/**
 * Dispatch a prompt to the local daemon connected for the given project.
 * The daemon will run the Agent SDK locally and stream chunk/done events back.
 *
 * @param {string} projectDir - Project directory to route the prompt to
 * @param {object} payload - Prompt payload
 * @param {string} payload.instanceId - Unique instance ID for correlation
 * @param {string} payload.sessionId - Dashboard session ID
 * @param {string} payload.prompt - The user's prompt text
 * @param {string} payload.cwd - Working directory for the prompt
 * @param {string} [payload.permissionMode] - Permission mode
 * @param {string} [payload.model] - Model override
 * @param {object} [payload.image] - Optional image attachment { data, mimeType }
 * @param {string} [payload.imagePath] - Temp image file path to clean up on done
 * @returns {string} The instanceId
 * @throws {Error} If no bridge daemon is connected for this project
 */
export function dispatchPromptToBridge(projectDir, payload) {
  const socket = findBridgeForProject(projectDir);
  if (!socket) {
    throw new Error(`No local agent connected for ${projectDir}`);
  }

  const { instanceId, sessionId, imagePath, ...rest } = payload;
  const now = Date.now();

  const entry = {
    sessionId,
    startedAt: now,
    lastActivity: now,
    socket,
    imagePath: imagePath || undefined,
    timeoutTimer: undefined,
  };
  activeBridgePrompts.set(instanceId, entry);

  // Start the activity timeout — will fire if daemon goes silent
  resetPromptTimeout(instanceId, entry);

  console.log(`[bridge] dispatching prompt ${instanceId} for session ${sessionId} to daemon ${socket.id} (cwd: ${rest.cwd || projectDir})`);
  socket.emit("prompt_start", { instanceId, sessionId, ...rest });
  return instanceId;
}

/**
 * (Re)start the inactivity timeout for a bridge prompt.
 * If no `prompt_chunk` or `prompt_done` arrives within BRIDGE_PROMPT_TIMEOUT_MS,
 * emit a synthetic `prompt:done` with an error so the UI isn't stuck forever.
 *
 * @param {string} instanceId
 * @param {{ sessionId: string, startedAt: number, lastActivity: number, timeoutTimer?: ReturnType<typeof setTimeout> }} entry
 */
function resetPromptTimeout(instanceId, entry) {
  if (entry.timeoutTimer) clearTimeout(entry.timeoutTimer);
  entry.timeoutTimer = setTimeout(() => {
    // Only fire if the entry is still tracked (not already completed/cleaned up)
    if (!activeBridgePrompts.has(instanceId)) return;

    const silentSec = Math.round((Date.now() - entry.lastActivity) / 1000);
    const totalSec = Math.round((Date.now() - entry.startedAt) / 1000);
    console.error(`[bridge] prompt ${instanceId} timed out — no activity for ${silentSec}s (total ${totalSec}s). Emitting synthetic prompt:done.`);

    broadcastToSession(entry.sessionId, {
      type: "prompt:done",
      sessionId: entry.sessionId,
      instanceId,
      exitCode: null,
      error: `Bridge prompt timed out — no response from local agent for ${silentSec}s`,
      cancelled: false,
      freshSession: false,
    });

    // Clean up
    if (entry.imagePath) {
      import("node:fs/promises").then(({ unlink }) => unlink(entry.imagePath).catch(() => {}));
    }
    activeBridgePrompts.delete(instanceId);
  }, BRIDGE_PROMPT_TIMEOUT_MS);
}

/**
 * Cancel an active bridge-relayed prompt.
 *
 * @param {string} instanceId - The instance ID of the prompt to cancel
 * @returns {boolean} True if the prompt was found and cancel was sent
 */
export function cancelBridgePrompt(instanceId) {
  const entry = activeBridgePrompts.get(instanceId);
  if (!entry) return false;

  entry.socket.emit("prompt_cancel", { instanceId });
  return true;
}

/**
 * Check whether a bridge-relayed prompt is active for the given session.
 *
 * @param {string} sessionId - Dashboard session ID
 * @returns {boolean}
 */
export function isBridgePromptActive(sessionId) {
  for (const entry of activeBridgePrompts.values()) {
    if (entry.sessionId === sessionId) return true;
  }
  return false;
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
