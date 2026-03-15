/**
 * auth.js — Core authentication module.
 *
 * Supports two modes:
 *   - Single-user mode (default): No GOOGLE_CLIENT_ID set. Works as before.
 *   - Multi-user mode: Google OAuth login, per-user API keys, cookie sessions.
 *
 * Dual-path auth resolution:
 *   Browser (cookie session) → decrypt → get userId → getUserById
 *   Hooks/Bridge (Bearer token) → getUserByApiKey
 *   Both paths produce request.user = { id, email, name, avatarUrl, dashboardApiKey }
 */

import { randomBytes } from "node:crypto";
import { getUserById, getUserByApiKey } from "./db-adapter.js";

// ---------------------------------------------------------------------------
// Mode detection
// ---------------------------------------------------------------------------

/**
 * Returns true when Google OAuth credentials are configured,
 * enabling multi-user mode with login, per-user API keys, and data scoping.
 */
export function isMultiUserMode() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

/**
 * Registers Fastify plugins required for multi-user auth:
 *   - @fastify/cookie (cookie parsing)
 *   - @fastify/secure-session (encrypted cookie sessions via sodium)
 *   - @fastify/oauth2 (Google OAuth2 redirect/callback flow)
 *
 * Must be called BEFORE route registration.
 *
 * @param {import("fastify").FastifyInstance} app
 */
export async function registerAuthPlugins(app) {
  const cookie = (await import("@fastify/cookie")).default;
  const secureSession = (await import("@fastify/secure-session")).default;
  const oauthPlugin = (await import("@fastify/oauth2")).default;

  await app.register(cookie);

  // Session secret: env var (hex-encoded 32 bytes) or auto-generated.
  // In production, SESSION_SECRET should be set to persist across restarts.
  const secretHex = process.env.SESSION_SECRET || randomBytes(32).toString("hex");
  const key = Buffer.from(secretHex, "hex");

  await app.register(secureSession, {
    key,
    cookieName: "chorus_session",
    cookie: {
      path: "/",
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60, // 7 days
    },
  });

  // Determine the OAuth callback URL.
  // APP_URL should be the public-facing URL (e.g. https://chorus.up.railway.app).
  // Falls back to localhost for local dev.
  const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3001}`;
  const callbackUri = process.env.OAUTH_CALLBACK_URL || `${appUrl}/api/auth/callback`;

  await app.register(oauthPlugin, {
    name: "googleOAuth2",
    scope: ["openid", "email", "profile"],
    credentials: {
      client: {
        id: process.env.GOOGLE_CLIENT_ID,
        secret: process.env.GOOGLE_CLIENT_SECRET,
      },
    },
    startRedirectPath: "/api/auth/login",
    callbackUri,
    discovery: {
      issuer: "https://accounts.google.com",
    },
  });

  app.log.info("Multi-user auth enabled (Google OAuth)");
}

// ---------------------------------------------------------------------------
// User resolution
// ---------------------------------------------------------------------------

/**
 * Formats a raw DB user row into the standard user object shape.
 * @param {object} row
 * @returns {{ id: string, email: string, name: string|null, avatarUrl: string|null, dashboardApiKey: string }}
 */
function formatUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name ?? null,
    avatarUrl: row.avatar_url ?? null,
    dashboardApiKey: row.dashboard_api_key,
  };
}

/**
 * Resolves the authenticated user from a Fastify request.
 * Tries cookie session first, then Bearer token.
 *
 * Returns null if:
 *   - No auth credentials present
 *   - Bearer token matches global DASHBOARD_API_KEY (admin, no user scoping)
 *
 * @param {import("fastify").FastifyRequest} request
 * @returns {Promise<object|null>}
 */
export async function resolveUser(request) {
  // Path 1: Cookie session (browser)
  if (request.session) {
    const data = request.session.get("user");
    if (data?.userId) {
      const user = await getUserById(data.userId);
      if (user) return formatUser(user);
    }
  }

  // Path 2: Bearer token (hooks, bridge, API clients)
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);

    // Global DASHBOARD_API_KEY = admin/automation, no specific user
    if (process.env.DASHBOARD_API_KEY && token === process.env.DASHBOARD_API_KEY) {
      return null;
    }

    // Per-user dashboard_api_key
    const user = await getUserByApiKey(token);
    if (user) return formatUser(user);
  }

  return null;
}

/**
 * Resolves a user from a raw Cookie header string.
 * Used for Socket.IO WebSocket upgrade requests where Fastify middleware
 * doesn't run (the cookie is in socket.handshake.headers.cookie).
 *
 * This is a best-effort approach — the secure-session plugin handles
 * decryption via the Fastify request lifecycle, so for Socket.IO we
 * fall back to Bearer token auth which is more reliable.
 *
 * @param {string|undefined} cookieHeader
 * @returns {Promise<object|null>}
 */
export async function resolveUserFromCookieHeader(cookieHeader) {
  // Cookie-based auth for Socket.IO is handled by the Fastify-level
  // session middleware when the upgrade request passes through.
  // For direct Socket.IO connections, we rely on the auth.token field.
  return null;
}

/**
 * Resolves a user from a Socket.IO handshake.
 * Checks auth.token field (Bearer-style per-user API key).
 *
 * @param {object} handshake - socket.handshake
 * @returns {Promise<object|null>}
 */
export async function resolveUserFromHandshake(handshake) {
  const token = handshake.auth?.token;
  if (!token) return null;

  // Global key = admin
  if (process.env.DASHBOARD_API_KEY && token === process.env.DASHBOARD_API_KEY) {
    return null;
  }

  const user = await getUserByApiKey(token);
  return user ? formatUser(user) : null;
}
