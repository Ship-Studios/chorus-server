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
import { broadcastToSession } from "../broadcast.js";

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
    // Guard against path traversal in .gitmodules — resolved path must stay within dir
    const absPath = resolve(dir, path);
    if (!absPath.startsWith(dir)) continue;
    if (!existsSyncFn(absPath)) continue;

    // Check if submodule has uncommitted changes.
    // diff --quiet exits non-zero when changes exist; catch only that case.
    try {
      await runGitFn(absPath, ["diff", "--quiet", "HEAD"]);
    } catch {
      submodules.push({ path, absPath });
      continue;
    }
    try {
      await runGitFn(absPath, ["diff", "--cached", "--quiet"]);
    } catch {
      submodules.push({ path, absPath });
      continue;
    }
    try {
      const untracked = (await runGitFn(absPath, ["ls-files", "--others", "--exclude-standard"])).trim();
      if (untracked) {
        submodules.push({ path, absPath });
      }
    } catch {
      // ls-files failure — skip rather than falsely reporting dirty
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
    broadcastToSession: broadcastToSessionImpl = broadcastToSession,
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
          const status = err.status;
          if (status === 429) return reply.code(429).send({ error: "Rate limited — try again later" });
          if (status === 529) return reply.code(503).send({ error: "AI service overloaded — try again later" });
          if (status === 401) return reply.code(502).send({ error: "API key configuration error" });
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
        const status = err?.status;
        if (status === 429) return reply.code(429).send({ error: "Rate limited — try again later" });
        if (status === 529) return reply.code(503).send({ error: "AI service overloaded — try again later" });
        if (status === 401) return reply.code(502).send({ error: "API key configuration error" });

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
