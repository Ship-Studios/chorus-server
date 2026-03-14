import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGit } from "@chorus/diff-panel/server";

export async function getDirtySubmodules(dir, runGitFn = runGit, existsSyncFn = existsSync) {
  if (!existsSyncFn(join(dir, ".gitmodules"))) {
    return [];
  }

  let gitmodulesContent;
  try {
    gitmodulesContent = await runGitFn(dir, ["config", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]);
  } catch {
    return [];
  }

  const submodules = [];
  for (const line of gitmodulesContent.trim().split("\n")) {
    const path = line.split(/\s+/)[1];
    if (!path) continue;
    const absPath = resolve(dir, path);
    if (!absPath.startsWith(dir)) continue;
    if (!existsSyncFn(absPath)) continue;

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
      // ignore
    }
  }
  return submodules;
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
    const previewDir = mkdtempSyncImpl(joinImpl(tmpdirImpl(), "chorus-commit-"));
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
