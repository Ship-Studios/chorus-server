import { spawn } from "node:child_process";
import { GIT } from "./git.js";

const DEFAULT_TIMEOUT = 30_000; // 30 seconds
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

export function runGit(cwd, args, { timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(GIT, args, { cwd });
    let stdout = "";
    let stderr = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      reject(new Error(`git ${args[0]} timed out after ${timeout}ms`));
    }, timeout);

    proc.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.length > MAX_BUFFER) {
        killed = true;
        proc.kill("SIGTERM");
        reject(new Error(`git ${args[0]} output exceeded ${MAX_BUFFER} bytes`));
      }
    });
    proc.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > MAX_BUFFER) {
        killed = true;
        proc.kill("SIGTERM");
        reject(new Error(`git ${args[0]} stderr exceeded ${MAX_BUFFER} bytes`));
      }
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      if (!killed) reject(new Error(`Failed to spawn git: ${err.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `git exited with code ${code}`));
    });
  });
}
