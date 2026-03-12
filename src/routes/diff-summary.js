import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { getSession, lookupSessionId } from "../db.js";
import { runGit } from "../run-git.js";
import { buildStatSummary, parseDiffToFiles } from "../diff.js";
import { summarizeDiff } from "../summarize-diff.js";

// ── In-memory cache keyed on SHA-256 of diff content ────────────────────────
const cache = new Map(); // Map<hash, { summary, model, timestamp }>
const CACHE_TTL_MS = 60_000;

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
  return entry;
}

// ── Anthropic client (lazy init) ────────────────────────────────────────────
let client = null;

function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic();
  return client;
}

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

    const dir = session.project_dir;
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

      // Cache the result
      cache.set(hash, { summary: result.summary, model: result.model, timestamp: Date.now() });

      // Cap cache size
      if (cache.size > 100) {
        const oldest = cache.keys().next().value;
        cache.delete(oldest);
      }

      return { summary: result.summary, model: result.model, cached: false };
    } catch (err) {
      fastify.log.error(err, "Anthropic API error");
      return reply.code(502).send({
        error: `Summary generation failed: ${err.message}`,
      });
    }
  });
}
