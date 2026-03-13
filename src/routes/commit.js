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
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { getSession, lookupSessionId } from "../db.js";
import { runGit, buildStatSummary, parseDiffToFiles } from "@agent-dashboard/diff-panel/server";
import { getAnthropicFetchOptions } from "../vpn.js";
import { broadcast } from "../broadcast.js";

const MAX_DIFF_CHARS = 30_000;
const MAX_SUBMODULE_DIFF_CHARS = 15_000;

const COMMIT_MSG_SYSTEM_PROMPT =
  "You generate git commit messages following the Conventional Commits format. " +
  "Analyze the diff and produce a commit message with:\n" +
  "- A type prefix: feat, fix, refactor, docs, chore, style, test, perf, ci, build\n" +
  "- An optional scope in parentheses if changes are focused on a specific area\n" +
  "- A concise subject line (under 72 characters) in imperative mood\n" +
  "- An optional body (separated by a blank line) with 1-3 bullet points explaining key changes, only if the change is non-trivial\n" +
  "Return ONLY the commit message text, no markdown formatting, no code fences, no explanation.";

function buildCommitPrompt(stat, diff) {
  return (
    "Generate a commit message for this diff.\n\n" +
    `<stat>\n${stat}\n</stat>\n\n` +
    `<diff>\n${diff}\n</diff>`
  );
}

const SUBMODULE_COMMIT_MSG_SYSTEM_PROMPT =
  "You generate git commit messages for a monorepo with submodules. " +
  "You will receive diffs from multiple scopes (submodules + parent repo). " +
  "Generate a SEPARATE commit message for each scope.\n\n" +
  "Rules:\n" +
  "- Each message follows Conventional Commits: type(scope): subject\n" +
  "- Subject line under 72 characters, imperative mood\n" +
  "- Optional body with 1-3 bullet points for non-trivial changes\n" +
  "- The parent message should summarize the overall change and mention submodule updates\n\n" +
  "Return a JSON object with keys matching the scope names, each value being the commit message string.\n" +
  "Example: {\"packages/server\": \"feat: add VPN proxy support\", \"parent\": \"feat: VPN proxy support\"}\n" +
  "Return ONLY the JSON object, no markdown, no code fences.";

function buildSubmoduleCommitPrompt(scopes) {
  const parts = ["Generate a commit message for each of the following scopes.\n"];
  for (const { name, stat, diff } of scopes) {
    parts.push(`<scope name="${name}">\n<stat>\n${stat}\n</stat>\n<diff>\n${diff}\n</diff>\n</scope>\n`);
  }
  return parts.join("\n");
}

/**
 * Detect submodules with uncommitted changes.
 * Parses .gitmodules to find submodule paths, then checks each for dirty state.
 * Returns array of { path, absPath } for dirty submodules.
 */
async function getDirtySubmodules(dir, runGitFn, existsSyncFn) {
  let gitmodulesContent;
  try {
    gitmodulesContent = await runGitFn(dir, ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]);
  } catch {
    return []; // No .gitmodules or no submodules
  }

  const submodules = [];
  for (const line of gitmodulesContent.trim().split("\n")) {
    const path = line.split(/\s+/)[1];
    if (!path) continue;
    const absPath = resolve(dir, path);
    if (!existsSyncFn(absPath)) continue;

    // Check if submodule has uncommitted changes
    try {
      await runGitFn(absPath, ["diff", "--quiet", "HEAD"]);
      await runGitFn(absPath, ["diff", "--cached", "--quiet"]);
      const untracked = (await runGitFn(absPath, ["ls-files", "--others", "--exclude-standard"])).trim();
      if (untracked) {
        submodules.push({ path, absPath });
        continue;
      }
    } catch {
      // diff --quiet exits non-zero when there are changes
      submodules.push({ path, absPath });
    }
  }
  return submodules;
}

function truncateDiff(diff) {
  if (diff.length > MAX_DIFF_CHARS) {
    return diff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated]";
  }
  return diff;
}

export function createBuildPreviewDiff(deps = {}) {
  const {
    runGit: runGitImpl = runGit,
    existsSync: existsSyncImpl = existsSync,
    copyFileSync: copyFileSyncImpl = copyFileSync,
    mkdtempSync: mkdtempSyncImpl = mkdtempSync,
    tmpdir: tmpdirImpl = tmpdir,
    join: joinImpl = join,
    resolve: resolveImpl = resolve,
    rmSync: rmSyncImpl = rmSync,
  } = deps;

  return async function buildPreviewDiff(dir) {
    const previewDir = mkdtempSyncImpl(joinImpl(tmpdirImpl(), "agent-dashboard-commit-"));
    const previewIndexPath = joinImpl(previewDir, "index");

    try {
      const rawGitIndexPath = (await runGitImpl(dir, ["rev-parse", "--git-path", "index"])).trim();
      const gitIndexPath = resolveImpl(dir, rawGitIndexPath);
      if (existsSyncImpl(gitIndexPath)) copyFileSyncImpl(gitIndexPath, previewIndexPath);

      const previewEnv = { GIT_INDEX_FILE: previewIndexPath };
      await runGitImpl(dir, ["add", "-A"], { env: previewEnv });

      try {
        return await runGitImpl(
          dir,
          ["diff", "--cached", "HEAD", "--no-color", "--unified=3", "--submodule=diff"],
          { env: previewEnv },
        );
      } catch {
        return await runGitImpl(
          dir,
          ["diff", "--cached", "--no-color", "--unified=3", "--submodule=diff"],
          { env: previewEnv },
        );
      }
    } finally {
      rmSyncImpl(previewDir, { recursive: true, force: true });
    }
  };
}

const buildPreviewDiff = createBuildPreviewDiff();

// ── Anthropic client (lazy init) ────────────────────────────────────────────
let client = null;

function getClient(AnthropicImpl, getAnthropicFetchOptionsImpl) {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new AnthropicImpl({ ...getAnthropicFetchOptionsImpl() });
  return client;
}

/** Reset cached client so next call picks up new VPN/proxy config. */
export function resetClient() { client = null; }

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
    broadcast: broadcastImpl = broadcast,
    buildPreviewDiff: buildPreviewDiffImpl = buildPreviewDiff,
  } = deps;

  return async function commitRoutes(fastify) {
    fastify.post("/api/sessions/:sessionId/commit", async (req, reply) => {
      const anthropic = getClient(AnthropicImpl, getAnthropicFetchOptionsImpl);
      if (!anthropic) {
        return reply.code(503).send({
          error: "Commit unavailable: ANTHROPIC_API_KEY not set",
        });
      }

      const sessionId = lookupSessionIdImpl(req.params.sessionId);
      const session = getSessionImpl.get({ $id: sessionId });
      if (!session) return reply.code(404).send({ error: "Session not found" });

      const dir = session.worktree_dir || session.project_dir;
      if (!dir || dir === "unknown") {
        return reply.code(400).send({ error: "Session has no known working directory" });
      }
      if (!existsSyncImpl(dir)) {
        return reply.code(400).send({ error: `Working directory no longer exists: ${dir}` });
      }

      // Build a preview diff from a temporary index so untracked files are included
      // without mutating the user's real staging area if AI generation fails.
      let diff;
      try {
        diff = await buildPreviewDiffImpl(dir);
      } catch (e) {
        return reply.code(500).send({ error: `Git error: ${e.message}` });
      }

      if (!diff || !diff.trim()) {
        return reply.code(400).send({ error: "No changes to commit" });
      }

      // Build stat context
      const files = parseDiffToFilesImpl(diff);
      const stat = buildStatSummaryImpl(files);
      const truncatedDiff = truncateDiff(diff);

      // Generate commit message via AI
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
        const status = err.status;
        if (status === 429) return reply.code(429).send({ error: "Rate limited — try again later" });
        if (status === 529) return reply.code(503).send({ error: "AI service overloaded — try again later" });
        if (status === 401) return reply.code(502).send({ error: "API key configuration error" });
        return reply.code(502).send({ error: `Commit message generation failed: ${err.message}` });
      }

      if (!commitMessage) {
        return reply.code(500).send({ error: "AI returned an empty commit message" });
      }

      // ── Submodule-aware commit cascade ──────────────────────────────
      // Detect dirty submodules and commit them first (inner→outer),
      // then commit the parent with updated submodule pointers.
      // When `body.submodules` is provided, only those paths are committed.
      // When `body.skipParent` is true, the parent commit is skipped.
      const { submodules: targetSubmodules, skipParent } = req.body ?? {};

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

      if (dirtySubmodules.length === 0) {
        // Simple case: no submodules, commit directly
        try {
          await runGitImpl(dir, ["add", "-A"]);
          await runGitImpl(dir, ["commit", "-m", commitMessage]);
        } catch (e) {
          return reply.code(500).send({ error: `Git commit failed: ${e.message}` });
        }

        broadcastImpl({ type: "diff:invalidated", sessionId });
        return { ok: true, message: commitMessage, stat, filesChanged: files.length };
      }

      // Submodule cascade: collect per-submodule diffs, generate messages, commit each
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

      // Add parent repo diff (excluding submodule content — just pointer changes + own files)
      // Omitted when the client is committing only child submodules.
      if (!skipParent) {
        scopes.push({ name: "parent", stat, diff: truncatedDiff, absPath: dir });
      }

      // Generate per-scope commit messages in one AI call
      let scopeMessages;
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
        // Fallback: use the single commit message for everything
        scopeMessages = {};
        for (const scope of scopes) {
          scopeMessages[scope.name] = commitMessage;
        }
      }

      // Commit submodules first (inner→outer)
      const committed = [];
      for (const sub of scopes.filter(s => s.name !== "parent")) {
        const msg = scopeMessages[sub.name] || commitMessage;
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
        broadcastImpl({ type: "diff:invalidated", sessionId });
        return {
          ok: true,
          message: committed.length
            ? `Committed ${committed.length} submodule${committed.length > 1 ? "s" : ""}`
            : "No submodule changes committed",
          stat,
          filesChanged: files.length,
          childOnly: true,
          submoduleCommits: committed.map(name => ({ name, message: scopeMessages[name] || commitMessage })),
        };
      }

      const parentMsg = scopeMessages["parent"] || commitMessage;
      try {
        await runGitImpl(dir, ["add", "-A"]);
        await runGitImpl(dir, ["commit", "-m", parentMsg]);
      } catch (e) {
        return reply.code(500).send({ error: `Parent commit failed: ${e.message}` });
      }

      broadcastImpl({ type: "diff:invalidated", sessionId });
      return {
        ok: true,
        message: parentMsg,
        stat,
        filesChanged: files.length,
        submoduleCommits: committed.map(name => ({ name, message: scopeMessages[name] || commitMessage })),
      };
    });
  };
}

export default createCommitRoutes();
