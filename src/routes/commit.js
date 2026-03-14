/**
 * AI-assisted commit route — generates a commit message from the current diff
 * using the Anthropic API, then commits all staged + unstaged changes.
 *
 * Endpoints:
 *   POST /api/sessions/:id/commit — Generate commit message and commit changes
 *
 * Uses the same Anthropic client pattern as diff-summary.js.
 *
 * @module routes/commit
 */
import { existsSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { getSession } from "../db-adapter.js";
import { lookupSessionId } from "../session-resolver.js";
import { runGit, buildStatSummary, parseDiffToFiles, truncateDiff } from "@chorus/diff-panel/server";
import { getAnthropicFetchOptions } from "../vpn.js";
import { broadcastToSession } from "../broadcast.js";
import { handleAnthropicError } from "../anthropic-error.js";
import {
  COMMIT_MSG_SYSTEM_PROMPT,
  SUBMODULE_COMMIT_MSG_SYSTEM_PROMPT,
  buildCommitPrompt,
  buildSubmoduleCommitPrompt,
} from "../commit-prompts.js";
import { createBuildPreviewDiff, getDirtySubmodules } from "../commit-git.js";
export { createBuildPreviewDiff } from "../commit-git.js";

const MAX_DIFF_CHARS = 30_000;
const MAX_SUBMODULE_DIFF_CHARS = 15_000;

const buildPreviewDiff = createBuildPreviewDiff();

// ── Anthropic client (lazy init) ────────────────────────────────────────────
let client = null;

/**
 * Get the Anthropic client, lazily initializing it if needed.
 *
 * @param {typeof Anthropic} AnthropicImpl - The Anthropic SDK constructor.
 * @param {Function} getAnthropicFetchOptionsImpl - Function to get VPN fetch options.
 * @returns {Anthropic|null} The Anthropic client, or null if API key is missing.
 */
function getClient(AnthropicImpl, getAnthropicFetchOptionsImpl) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new AnthropicImpl({ ...getAnthropicFetchOptionsImpl() });
  return client;
}

/** Reset cached client so next call picks up new VPN/proxy config. */
export function resetClient() { client = null; }

/**
 * Create the commit routes Fastify plugin.
 *
 * @param {object} [deps={}] - Dependency overrides for testing.
 * @returns {import("fastify").FastifyPluginAsync} The commit routes plugin.
 */
export function createCommitRoutes(deps = {}) {
  const {
    existsSync: existsSyncImpl = existsSync,
    Anthropic: AnthropicImpl = Anthropic,
    getSession: getSessionImpl = getSession,
    lookupSessionId: lookupSessionIdImpl = lookupSessionId,
    runGit: runGitImpl = runGit,
    buildStatSummary: buildStatSummaryImpl = buildStatSummary,
    parseDiffToFiles: parseDiffToFilesImpl = parseDiffToFiles,
    getAnthropicFetchOptions: getAnthropicFetchOptionsImpl = getAnthropicFetchOptions,
    broadcastToSession: broadcastToSessionImpl = broadcastToSession,
    buildPreviewDiff: buildPreviewDiffImpl = buildPreviewDiff,
  } = deps;

  return async function commitRoutes(fastify) {
    fastify.post("/api/sessions/:sessionId/commit", { config: { rateLimit: { max: 5, timeWindow: 60_000 } } }, async (req, reply) => {
      const anthropic = getClient(AnthropicImpl, getAnthropicFetchOptionsImpl);
      if (!anthropic) {
        return reply.code(503).send({
          error: "Commit unavailable: ANTHROPIC_API_KEY not set",
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

      // ── Detect dirty submodules BEFORE the preview diff ────────────
      // buildPreviewDiff uses `git diff --cached HEAD` which only sees
      // submodule *pointer* changes. If the submodule HEAD hasn't moved
      // (changes are uncommitted inside it), the parent diff is empty.
      // Detecting dirty submodules first prevents a false "No changes" bail-out.
      const { submodules: targetSubmodules, skipParent } = req.body ?? {};

      // Validate body field types when present
      if (targetSubmodules !== undefined && !Array.isArray(targetSubmodules)) {
        return reply.code(400).send({ error: "submodules must be an array of strings" });
      }
      if (targetSubmodules?.some(s => typeof s !== "string")) {
        return reply.code(400).send({ error: "submodules must be an array of strings" });
      }

      let dirtySubmodules = await getDirtySubmodules(dir, runGitImpl, existsSyncImpl);

      // Filter to requested submodules when specified
      if (Array.isArray(targetSubmodules) && targetSubmodules.length > 0) {
        dirtySubmodules = dirtySubmodules.filter(
          (sub) => targetSubmodules.includes(sub.path),
        );
      }

      if (dirtySubmodules.length === 0 && skipParent) {
        return reply.code(400).send({ error: "No matching dirty submodules found" });
      }

      // Build a preview diff from a temporary index so untracked files are included
      // without mutating the user's real staging area if AI generation fails.
      let diff;
      try {
        diff = await buildPreviewDiffImpl(dir);
      } catch (e) {
        return reply.code(500).send({ error: `Git error: ${e.message}` });
      }

      // Only bail out when BOTH the parent diff is empty AND no submodules are dirty.
      // When changes are entirely inside submodules, the parent preview diff can be
      // empty (submodule pointers unchanged) but there's still work to do.
      if ((!diff || !diff.trim()) && dirtySubmodules.length === 0) {
        return reply.code(400).send({ error: "No changes to commit" });
      }

      const hasParentChanges = !!(diff && diff.trim());

      // Build stat context from whatever parent diff we have
      const files = hasParentChanges ? parseDiffToFilesImpl(diff) : [];
      const stat = hasParentChanges ? buildStatSummaryImpl(files) : "";
      const truncatedDiff = hasParentChanges ? truncateDiff(diff) : "";

      if (dirtySubmodules.length === 0) {
        // ── Simple case: no submodules, commit directly ───────────────
        let commitMessage;
        try {
          const model = process.env.DIFF_SUMMARY_MODEL ?? "claude-haiku-4-5-20251001";
          const msg = await anthropic.messages.create({
            model,
            max_tokens: 512,
            system: [{ type: "text", text: COMMIT_MSG_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: buildCommitPrompt(stat, truncatedDiff) }],
          });
          commitMessage = msg.content[0]?.text?.trim() ?? "";
        } catch (err) {
          fastify.log.error(err, "Anthropic API error during commit message generation");
          if (handleAnthropicError(err, reply)) return;
          return reply.code(502).send({ error: `Commit message generation failed: ${err.message}` });
        }

        if (!commitMessage) {
          return reply.code(500).send({ error: "AI returned an empty commit message" });
        }

        try {
          await runGitImpl(dir, ["add", "-A"]);
          await runGitImpl(dir, ["commit", "-m", commitMessage]);
        } catch (e) {
          return reply.code(500).send({ error: `Git commit failed: ${e.message}` });
        }

        broadcastToSessionImpl(sessionId, { type: "diff:invalidated", sessionId });
        return { ok: true, message: commitMessage, stat, filesChanged: files.length };
      }

      // ── Submodule cascade ──────────────────────────────────────────
      // Collect per-submodule diffs, generate per-scope AI messages,
      // then commit each submodule (inner→outer) followed by the parent.
      const scopes = [];
      for (const sub of dirtySubmodules) {
        try {
          let subDiff = await runGitImpl(sub.absPath, ["diff", "HEAD", "--no-color", "--unified=3"]);
          if (!subDiff.trim()) {
            // Include untracked files via the preview diff approach
            subDiff = await buildPreviewDiffImpl(sub.absPath);
          }
          if (!subDiff?.trim()) continue;
          const subFiles = parseDiffToFilesImpl(subDiff);
          const subStat = buildStatSummaryImpl(subFiles);
          const truncated = subDiff.length > MAX_SUBMODULE_DIFF_CHARS
            ? subDiff.slice(0, MAX_SUBMODULE_DIFF_CHARS) + "\n\n[diff truncated]"
            : subDiff;
          scopes.push({ name: sub.path, stat: subStat, diff: truncated, absPath: sub.absPath });
        } catch {
          // Skip submodules whose diff can't be read
        }
      }

      // If all submodule diffs failed and we're in child-only mode, bail out
      // rather than making an AI call with an empty prompt.
      if (scopes.length === 0 && skipParent) {
        return reply.code(400).send({ error: "Could not read diffs from any dirty submodules" });
      }

      // Add parent repo scope. Use --ignore-submodules to get only the parent's
      // own file changes, so the AI generates a focused parent commit message
      // (not duplicating submodule details). When the parent has no own changes,
      // supply a synthetic description so the AI knows it's a pointer-update commit.
      if (!skipParent) {
        let parentOwnDiff = "";
        if (hasParentChanges) {
          try {
            parentOwnDiff = await runGitImpl(dir, [
              "diff", "HEAD", "--no-color", "--unified=3", "--ignore-submodules",
            ]);
          } catch {
            // Fall back to full diff if --ignore-submodules fails
            parentOwnDiff = truncatedDiff;
          }
        }
        const subNames = scopes.map(s => s.name).join(", ");
        if (parentOwnDiff.trim()) {
          const parentFiles = parseDiffToFilesImpl(parentOwnDiff);
          const parentStat = buildStatSummaryImpl(parentFiles);
          const parentTruncated = truncateDiff(parentOwnDiff);
          scopes.push({ name: "parent", stat: parentStat, diff: parentTruncated, absPath: dir });
        } else {
          // Parent has no own file changes — only submodule pointer updates
          scopes.push({
            name: "parent",
            stat: `Submodule pointer updates: ${subNames}`,
            diff: `Update submodule pointers for: ${subNames}`,
            absPath: dir,
          });
        }
      }

      // Generate per-scope commit messages in one AI call
      let scopeMessages;
      let aiFallback = false;
      try {
        const model = process.env.DIFF_SUMMARY_MODEL ?? "claude-haiku-4-5-20251001";
        const msg = await anthropic.messages.create({
          model,
          max_tokens: 1024,
          system: [{ type: "text", text: SUBMODULE_COMMIT_MSG_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: buildSubmoduleCommitPrompt(scopes) }],
        });
        const raw = msg.content[0]?.text?.trim() ?? "";
        scopeMessages = JSON.parse(raw);
      } catch (err) {
        // Distinguish API errors from JSON parse errors — propagate rate limits
        // and auth failures so the caller knows, rather than silently falling back.
        if (handleAnthropicError(err, reply)) return;

        // JSON parse error or other non-critical failure: fall back to simple messages
        aiFallback = true;
        fastify.log.warn(err, "Submodule commit message generation failed, using fallback");
        scopeMessages = {};
        for (const scope of scopes) {
          scopeMessages[scope.name] = scope.name === "parent"
            ? `chore: update submodule pointers`
            : `chore(${scope.name.split("/").pop()}): update`;
        }
      }

      // Commit submodules first (inner→outer)
      const committed = [];
      for (const sub of scopes.filter(s => s.name !== "parent")) {
        const msg = scopeMessages[sub.name] || `chore(${sub.name.split("/").pop()}): update`;
        try {
          await runGitImpl(sub.absPath, ["add", "-A"]);
          await runGitImpl(sub.absPath, ["commit", "-m", msg]);
          committed.push(sub.name);
        } catch (e) {
          // Non-fatal: skip submodule if it can't be committed (e.g. nothing to commit)
          fastify.log.warn(`Submodule commit skipped for ${sub.name}: ${e.message}`);
        }
      }

      // Commit parent (stages updated submodule pointers + own changes)
      // Skipped when the client requests child-only commits.
      if (skipParent) {
        broadcastToSessionImpl(sessionId, { type: "diff:invalidated", sessionId });
        return {
          ok: true,
          message: committed.length
            ? `Committed ${committed.length} submodule${committed.length > 1 ? "s" : ""}`
            : "No submodule changes committed",
          stat,
          filesChanged: files.length,
          childOnly: true,
          submoduleCommits: committed.map(name => ({ name, message: scopeMessages[name] || "" })),
        };
      }

      const parentMsg = scopeMessages["parent"] || `chore: update submodule pointers`;
      try {
        await runGitImpl(dir, ["add", "-A"]);
        await runGitImpl(dir, ["commit", "-m", parentMsg]);
      } catch (e) {
        // If the parent commit fails because there's truly nothing to commit
        // (e.g. all submodule commits were skipped), report partial success
        // when at least one submodule was committed.
        if (committed.length > 0) {
          broadcastToSessionImpl(sessionId, { type: "diff:invalidated", sessionId });
          return {
            ok: true,
            message: `Committed ${committed.length} submodule${committed.length > 1 ? "s" : ""}`,
            stat,
            filesChanged: files.length,
            childOnly: true,
            submoduleCommits: committed.map(name => ({ name, message: scopeMessages[name] || "" })),
          };
        }
        return reply.code(500).send({ error: `Parent commit failed: ${e.message}` });
      }

      broadcastToSessionImpl(sessionId, { type: "diff:invalidated", sessionId });
      return {
        ok: true,
        message: parentMsg,
        stat,
        filesChanged: files.length,
        submoduleCommits: committed.map(name => ({ name, message: scopeMessages[name] || "" })),
      };
    });
  };
}

export default createCommitRoutes();
