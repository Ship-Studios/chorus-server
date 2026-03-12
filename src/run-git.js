import { spawn } from "node:child_process";
import { GIT } from "./git.js";

const DEFAULT_TIMEOUT = 30_000; // 30 seconds
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

export function runGit(cwd, args, { timeout = DEFAULT_TIMEOUT } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(GIT, args, { cwd });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
      reject(new Error(`git ${args[0]} timed out after ${timeout}ms`));
    }, timeout);

    proc.stdout.on("data", (d) => {
      stdoutLen += d.length;
      if (stdoutLen > MAX_BUFFER) {
        killed = true;
        proc.kill("SIGTERM");
        reject(new Error(`git ${args[0]} output exceeded ${MAX_BUFFER} bytes`));
        return;
      }
      stdoutChunks.push(d);
    });
    proc.stderr.on("data", (d) => {
      stderrLen += d.length;
      if (stderrLen > MAX_BUFFER) {
        killed = true;
        proc.kill("SIGTERM");
        reject(new Error(`git ${args[0]} stderr exceeded ${MAX_BUFFER} bytes`));
        return;
      }
      stderrChunks.push(d);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      if (!killed) reject(new Error(`Failed to spawn git: ${err.message}`));
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (killed) return;
      const stdout = Buffer.concat(stdoutChunks).toString();
      if (code === 0) resolve(stdout);
      else reject(new Error(Buffer.concat(stderrChunks).toString() || `git exited with code ${code}`));
    });
  });
}
