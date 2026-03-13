import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { getSession, lookupSessionId } from "../db.js";
import { runGit, buildStatSummary, parseDiffToFiles, summarizeDiff } from "@agent-dashboard/diff-panel/server";
import { getAnthropicFetchOptions } from "../vpn.js";

// ── In-memory cache keyed on SHA-256 of diff content ────────────────────────
const cache = new Map(); // Map<hash, { summary, model, timestamp }>
const CACHE_TTL_MS = 600_000; // 10 minutes — safe because cache is keyed on diff content hash

function hashDiff(diff) {
  return createHash("sha256").update(diff).digest("hex");
}

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

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ ...getAnthropicFetchOptions() });
  return client;
}

/** Reset cached client so next call picks up new VPN/proxy config. */
export function resetClient() { client = null; }

export default async function diffSummaryRoutes(fastify) {
  // Feature availability check
  fastify.get("/api/diff-summary/status", async () => ({
    available: !!process.env.ANTHROPIC_API_KEY,
  }));

  // Generate summary for a session's current diff
  fastify.post("/api/sessions/:sessionId/diff/summary", async (req, reply) => {
    const anthropic = getClient();
    if (!anthropic) {
      return reply.code(503).send({
        error: "Diff summary unavailable: ANTHROPIC_API_KEY not set",
        available: false,
      });
    }

    const sessionId = lookupSessionId(req.params.sessionId);
    const session = getSession.get({ $id: sessionId });
    if (!session) return reply.code(404).send({ error: "Session not found" });

    const dir = session.worktree_dir || session.project_dir;
    if (!dir || dir === "unknown") {
      return reply.code(400).send({ error: "Session has no known working directory" });
    }
    if (!existsSync(dir)) {
      return reply.code(400).send({ error: `Working directory no longer exists: ${dir}` });
    }

    // Get the current diff
    let diff;
    try {
      diff = await runGit(dir, ["diff", "HEAD", "--no-color", "--unified=3", "--submodule=diff"]);
    } catch {
      try {
        diff = await runGit(dir, ["diff", "--no-color", "--unified=3", "--submodule=diff"]);
      } catch (e) {
        return reply.code(500).send({ error: `Git error: ${e.message}` });
      }
    }

    if (!diff || !diff.trim()) {
      return { summary: null, empty: true };
    }

    // Check cache
    const hash = hashDiff(diff);
    const cached = getCached(hash);
    if (cached) {
      return { summary: cached.summary, model: cached.model, cached: true };
    }

    // Build stat context
    const files = parseDiffToFiles(diff);
    const stat = buildStatSummary(files);

    try {
      const result = await summarizeDiff({ diff, stat, client: anthropic });

      // Only cache non-empty summaries
      if (result.summary) {
        cache.set(hash, { summary: result.summary, model: result.model, timestamp: Date.now() });

        // Cap cache size (LRU: evict oldest-inserted entry)
        if (cache.size > 100) {
          const oldest = cache.keys().next().value;
          cache.delete(oldest);
        }
      }

      return { summary: result.summary, model: result.model, cached: false };
    } catch (err) {
      fastify.log.error(err, "Anthropic API error");
      // Distinguish retriable errors from permanent failures
      const status = err.status;
      if (status === 429) {
        const retryAfter = err.headers?.["retry-after"];
        const headers = retryAfter ? { "Retry-After": retryAfter } : {};
        return reply.code(429).headers(headers).send({ error: "Rate limited — try again later" });
      }
      if (status === 529) {
        return reply.code(503).send({ error: "AI service overloaded — try again later" });
      }
      if (status === 401) {
        return reply.code(502).send({ error: "API key configuration error" });
      }
      return reply.code(502).send({
        error: `Summary generation failed: ${err.message}`,
      });
    }
  });
}
