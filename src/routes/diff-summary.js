/**
 * AI diff summary route — generates concise natural-language summaries of git diffs
 * using the Anthropic API.
 *
 * Endpoints:
 *   POST /api/sessions/:id/diff/summary — Generate or return cached summary
 *   GET  /api/diff-summary/status       — Check if ANTHROPIC_API_KEY is configured
 *
 * Caching: Summaries are cached in-memory keyed on the SHA-256 hash of the raw diff
 * content. Cache entries have a 10-minute TTL and the cache is capped at 100 entries
 * with LRU eviction (oldest-inserted entry removed when cap is exceeded).
 *
 * Content-addressable caching means the same diff always returns the same summary
 * regardless of which session requested it, and re-running `git diff` after
 * reverting changes won't produce stale summaries.
 *
 * The Anthropic client is lazily initialized with VPN-aware fetchOptions (proxy + TLS)
 * via `getAnthropicFetchOptions()`. The cached client is invalidated on
 * `/api/vpn/reconfigure` so it picks up new network config.
 *
 * Error handling distinguishes retriable errors (429 rate limit, 529 overloaded)
 * from permanent failures (401 bad key) and passes through appropriate HTTP status
 * codes so the UI can show actionable messages.
 *
 * @module routes/diff-summary
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { getSession } from "../db-adapter.js";
import { lookupSessionId } from "../session-resolver.js";
import { runGit, buildStatFromShortstat, summarizeDiff } from "@chorus/diff-panel/server";
import { getAnthropicFetchOptions } from "../vpn.js";
import { handleAnthropicError } from "../anthropic-error.js";

// ── In-memory cache keyed on SHA-256 of diff content ────────────────────────
const cache = new Map(); // Map<hash, { summary, model, timestamp }>
const inflight = new Map(); // Map<hash, Promise<{ summary, model }>>
const CACHE_TTL_MS = 600_000; // 10 minutes — safe because cache is keyed on diff content hash

/**
 * Generate a SHA-256 hash of the diff content.
 *
 * @param {string} diff - The diff content to hash.
 * @returns {string} The hex-encoded hash.
 */
function hashDiff(diff) {
  return createHash("sha256").update(diff).digest("hex");
}

/**
 * Get a cached summary for a given diff hash, checking for TTL.
 *
 * @param {string} hash - The hash of the diff content.
 * @returns {object|null} The cached entry if valid, otherwise null.
 */
function getCached(hash) {
  const entry = cache.get(hash);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(hash);
    return null;
  }
  // Move to end for true LRU eviction
  cache.delete(hash);
  cache.set(hash, entry);
  return entry;
}

// ── Anthropic client (lazy init) ────────────────────────────────────────────
let client = null;

/** Reset cached client so next call picks up new VPN/proxy config. */
export function resetClient() { client = null; }

/**
 * Reset all in-process summary state for testing.
 *
 * Clears the in-memory diff cache, the in-flight deduplication map, and the
 * lazily-initialised Anthropic client so that each test starts from a clean
 * slate without side-effects leaking between test cases.
 *
 * @remarks
 * This is intentionally **test-only** — calling it in production discards
 * valid cached summaries and forces a new Anthropic client (with a fresh
 * VPN-config snapshot) to be created on the next request.  Production code
 * should call `resetClient()` instead when only the client needs to be
 * invalidated (e.g. after `/api/vpn/reconfigure`).
 */
export function clearSummaryState() {
  cache.clear();
  inflight.clear();
  client = null;
}

/**
 * Factory that returns a Fastify plugin registering the diff-summary routes.
 *
 * Accepts an optional `deps` bag for dependency injection in tests.  Every
 * injectable dependency defaults to the real production implementation so
 * callers only need to override what they want to stub.
 *
 * Registered routes:
 *   - `GET  /api/diff-summary/status`            — feature availability probe
 *   - `POST /api/sessions/:sessionId/diff/summary` — generate / return cached summary
 *
 * @param {object} [deps={}] - Optional dependency overrides (for testing).
 * @param {typeof Anthropic} [deps.Anthropic] - Anthropic SDK constructor.
 * @param {Function} [deps.buildStatFromShortstat] - Builds a stat object from `git diff --shortstat`.
 * @param {Function} [deps.existsSync] - `fs.existsSync` — checks working directory existence.
 * @param {Function} [deps.getAnthropicFetchOptions] - Returns VPN-aware fetch options for the Anthropic client.
 * @param {Function} [deps.getSession] - Prepared statement that fetches a session row by ID.
 * @param {Function} [deps.lookupSessionId] - Resolves a raw session ID to its canonical dashboard ID.
 * @param {Function} [deps.runGit] - Executes a git command in a given directory.
 * @param {Function} [deps.summarizeDiff] - Calls the Anthropic API to produce a diff summary.
 * @returns {Function} An async Fastify plugin function.
 */
export function createDiffSummaryRoutes(deps = {}) {
  const {
    Anthropic: AnthropicImpl = Anthropic,
    buildStatFromShortstat: buildStatFromShortstatImpl = buildStatFromShortstat,
    existsSync: existsSyncImpl = existsSync,
    getAnthropicFetchOptions: getAnthropicFetchOptionsImpl = getAnthropicFetchOptions,
    getSession: getSessionImpl = getSession,
    lookupSessionId: lookupSessionIdImpl = lookupSessionId,
    runGit: runGitImpl = runGit,
    summarizeDiff: summarizeDiffImpl = summarizeDiff,
  } = deps;

  /**
   * Return the lazily-initialised Anthropic client, or `null` when no API key
   * is configured.  The module-level `client` variable is intentionally shared
   * across requests so the same HTTP connection pool is reused.
   *
   * @returns {import("@anthropic-ai/sdk").Anthropic|null}
   */
  function getClientImpl() {
    if (!process.env.ANTHROPIC_API_KEY) return null;
    if (!client) client = new AnthropicImpl({ ...getAnthropicFetchOptionsImpl() });
    return client;
  }

  return async function diffSummaryRoutes(fastify) {
    /**
     * GET /api/diff-summary/status
     *
     * Lightweight probe so the UI can decide whether to show the "Summarise"
     * button without making a real summary request.  Returns `{ available: boolean }`.
     */
    fastify.get("/api/diff-summary/status", async () => ({
      available: !!process.env.ANTHROPIC_API_KEY,
    }));

    /**
     * POST /api/sessions/:sessionId/diff/summary
     *
     * Generate (or return a cached) natural-language summary of the session's
     * current `git diff HEAD`.
     *
     * Response shapes:
     *   - `{ summary: null, empty: true }`               — working tree is clean
     *   - `{ summary, model, cached: true }`             — served from LRU cache
     *   - `{ summary, model, cached: false }`            — freshly generated
     *
     * Error responses (HTTP status codes):
     *   - `503` — `ANTHROPIC_API_KEY` not set, or AI service overloaded (529)
     *   - `404` — session not found
     *   - `400` — session has no known / existing working directory
     *   - `429` — Anthropic rate limit; may include `Retry-After` header
     *   - `502` — bad API key (401) or other Anthropic error
     *   - `500` — git command failed
     *
     * Concurrent requests for the same diff hash are deduplicated via the
     * `inflight` map — only one Anthropic API call is made regardless of how
     * many requests arrive while the first is in-flight.
     */
    fastify.post("/api/sessions/:sessionId/diff/summary", { config: { rateLimit: { max: 10, timeWindow: 60_000 } } }, async (req, reply) => {
      const anthropic = getClientImpl();
      if (!anthropic) {
        return reply.code(503).send({
          error: "Diff summary unavailable: ANTHROPIC_API_KEY not set",
          available: false,
        });
      }

      const sessionId = await lookupSessionIdImpl(req.params.sessionId);
      const session = await getSessionImpl(sessionId);
      if (!session) return reply.code(404).send({ error: "Session not found" });

      const dir = session.worktree_dir || session.project_dir;
      if (!dir || dir === "unknown") {
        return reply.code(400).send({ error: "Session has no known working directory" });
      }
      if (!existsSyncImpl(dir)) {
        return reply.code(400).send({ error: `Working directory no longer exists: ${dir}` });
      }

      // Get the current diff
      let diff;
      try {
        diff = await runGitImpl(dir, ["diff", "HEAD", "--no-color", "--unified=3", "--submodule=diff"]);
      } catch {
        try {
          diff = await runGitImpl(dir, ["diff", "--no-color", "--unified=3", "--submodule=diff"]);
        } catch (e) {
          return reply.code(500).send({ error: `Git error: ${e.message}` });
        }
      }

      if (!diff || !diff.trim()) {
        return { summary: null, empty: true };
      }

      const hash = hashDiff(diff);
      const cached = getCached(hash);
      if (cached) {
        return { summary: cached.summary, model: cached.model, cached: true };
      }

      try {
        let pending = inflight.get(hash);
        if (!pending) {
          pending = (async () => {
            const stat = await buildStatFromShortstatImpl(dir);
            const result = await summarizeDiffImpl({ diff, stat, client: anthropic });

            if (result.summary) {
              cache.set(hash, { summary: result.summary, model: result.model, timestamp: Date.now() });

              if (cache.size > 100) {
                const oldest = cache.keys().next().value;
                cache.delete(oldest);
              }
            }

            return { summary: result.summary, model: result.model };
          })().finally(() => {
            inflight.delete(hash);
          });
          inflight.set(hash, pending);
        }

        const result = await pending;
        return { summary: result.summary, model: result.model, cached: false };
      } catch (err) {
        fastify.log.error(err, "Anthropic API error");
        if (handleAnthropicError(err, reply)) return;
        return reply.code(502).send({
          error: `Summary generation failed: ${err.message}`,
        });
      }
    });
  };
}

export default createDiffSummaryRoutes();
