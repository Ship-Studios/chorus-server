import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { CONFIG_EXTS, IGNORE_DIRS, SOURCE_EXTS, parseImports } from "./architecture-parsers.js";

const MAX_FILES = 400;
const MAX_DEPTH = 8;
const MAX_FILE_SIZE = 256 * 1024;
const FILE_PARSE_CONCURRENCY = 8;

export async function forEachConcurrent(items, limit, worker) {
  const concurrency = Math.min(limit, items.length);
  if (concurrency <= 1) {
    for (const item of items) {
      await worker(item);
    }
    return;
  }

  let index = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await worker(items[currentIndex]);
    }
  }));
}

export async function walkProjectFiles(projectDir, opts = {}) {
  const {
    maxFiles = MAX_FILES,
    maxDepth = MAX_DEPTH,
    maxFileSize = MAX_FILE_SIZE,
    fileParseConcurrency = FILE_PARSE_CONCURRENCY,
  } = opts;

  const files = [];
  const fileImports = new Map();

  await walk(projectDir, "", 0);
  return { files, fileImports };

  async function walk(dir, rel, depth) {
    if (depth > maxDepth || files.length >= maxFiles) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const fileJobs = [];
    for (const entry of entries) {
      if (files.length >= maxFiles) break;
      const fullPath = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(fullPath, relPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (!SOURCE_EXTS.has(ext) && !CONFIG_EXTS.has(ext)) continue;
        if (CONFIG_EXTS.has(ext) && depth === 0) continue;

        files.push({ relPath, ext, fullPath });

        if (SOURCE_EXTS.has(ext)) {
          fileJobs.push({ ext, fullPath, relPath });
        }
      }
    }

    await forEachConcurrent(fileJobs, fileParseConcurrency, async ({ ext, fullPath, relPath }) => {
      try {
        const s = await stat(fullPath);
        if (s.size > maxFileSize) return;
        const content = await readFile(fullPath, "utf-8");
        const imports = parseImports(content, ext);
        if (imports.size > 0) fileImports.set(relPath, imports);
      } catch {
        // skip unreadable
      }
    });
  }
}
