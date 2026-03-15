/**
 * routes/auth.js — Google OAuth login/callback/logout and auth status.
 *
 * Endpoints:
 *   GET  /api/auth/status         — Returns { multiUser, user } for UI bootstrapping
 *   GET  /api/auth/login          — Redirects to Google OAuth (handled by @fastify/oauth2)
 *   GET  /api/auth/callback       — OAuth callback → upsert user → set cookie → redirect
 *   POST /api/auth/logout         — Clears session cookie
 *   POST /api/auth/regenerate-key — Regenerate the current user's dashboard_api_key
 */

import { randomBytes, randomUUID } from "node:crypto";
import { isMultiUserMode, resolveUser } from "../auth.js";
import { upsertUser, updateUserApiKey } from "../db-adapter.js";

export default async function authRoutes(app) {
  // -----------------------------------------------------------------------
  // GET /api/auth/status — UI calls this on mount to determine auth state
  // -----------------------------------------------------------------------
  app.get("/api/auth/status", async (request, reply) => {
    const multiUser = isMultiUserMode();

    if (!multiUser) {
      return { multiUser: false, user: null };
    }

    const user = await resolveUser(request);
    return { multiUser: true, user };
  });

  // In single-user mode, skip registering OAuth routes entirely
  if (!isMultiUserMode()) return;

  // -----------------------------------------------------------------------
  // GET /api/auth/callback — Google OAuth callback
  // -----------------------------------------------------------------------
  app.get("/api/auth/callback", async (request, reply) => {
    try {
      // Exchange the authorization code for tokens
      const tokenResult = await app.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(request);
      const accessToken = tokenResult.token?.access_token;

      if (!accessToken) {
        app.log.error("OAuth callback: no access_token in token response");
        return reply.redirect("/?error=auth_failed");
      }

      // Fetch Google userinfo
      const userinfoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!userinfoRes.ok) {
        app.log.error(`OAuth callback: userinfo fetch failed (${userinfoRes.status})`);
        return reply.redirect("/?error=auth_failed");
      }

      const profile = await userinfoRes.json();
      const { sub: googleId, email, name, picture } = profile;

      if (!googleId || !email) {
        app.log.error("OAuth callback: missing googleId or email in userinfo");
        return reply.redirect("/?error=auth_failed");
      }

      // Upsert user — generates a new dashboard_api_key for first-time users
      const apiKey = randomBytes(32).toString("hex");
      const user = await upsertUser({
        id: randomUUID(),
        googleId,
        email,
        name: name ?? null,
        avatarUrl: picture ?? null,
        apiKey,
      });

      // Set session cookie
      request.session.set("user", { userId: user.id });

      app.log.info(`User authenticated: ${email} (${user.id})`);
      return reply.redirect("/");
    } catch (err) {
      app.log.error({ err }, "OAuth callback failed");
      return reply.redirect("/?error=auth_failed");
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/auth/logout
  // -----------------------------------------------------------------------
  app.post("/api/auth/logout", async (request, reply) => {
    request.session.delete();
    return { ok: true };
  });

  // -----------------------------------------------------------------------
  // POST /api/auth/regenerate-key — regenerate the current user's API key
  // -----------------------------------------------------------------------
  app.post("/api/auth/regenerate-key", async (request, reply) => {
    const user = await resolveUser(request);
    if (!user) {
      return reply.code(401).send({ error: "Authentication required" });
    }

    const newApiKey = randomBytes(32).toString("hex");
    const updated = await updateUserApiKey(user.id, newApiKey);

    if (!updated) {
      return reply.code(500).send({ error: "Failed to regenerate key" });
    }

    return { ok: true, dashboardApiKey: newApiKey };
  });
}
