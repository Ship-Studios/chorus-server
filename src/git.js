import { execFileSync, execSync } from "node:child_process";

/**
 * Resolves a working git binary path.
 *
 * Strategy: test candidates by actually running `git --version`.
 * Under vpn-exec, the bare "git" on PATH may work while /usr/bin/git
 * is blocked, so we try bare "git" first (via shell) before absolute paths.
 */
function findGit() {
  // 1. Try bare "git" via shell — this respects vpn-exec's PATH/wrappers
  try {
    execSync("git --version", { stdio: "pipe", timeout: 3000 });
    return "git";
  } catch {
    // bare git not available
  }

  // 2. Try common absolute paths
  const candidates = [
    "/opt/homebrew/bin/git",
    "/usr/local/bin/git",
    "/usr/bin/git",
  ];

  for (const p of candidates) {
    try {
      execFileSync(p, ["--version"], { stdio: "pipe", timeout: 3000 });
      return p;
    } catch {
      // not here or blocked, try next
    }
  }

  // Last resort — return bare "git" and let it fail at call site with a clear error
  console.warn("[git] Warning: could not find a working git binary");
  return "git";
}

export const GIT = findGit();
