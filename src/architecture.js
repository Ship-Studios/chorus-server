/**
 * Project architecture scanner.
 *
 * Walks a project directory, discovers source files, parses import relationships,
 * and builds an ArchNode tree + data-flow edges for the FractalArchitecture component.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname, basename, dirname, sep } from "node:path";

// ── Configuration ───────────────────────────────────────────────────────────

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".svelte-kit", ".next", ".nuxt",
  "__pycache__", ".venv", "venv", "coverage", ".turbo", ".cache", ".output",
  "target", ".expo", ".parcel-cache", "out", ".vercel", ".netlify",
  ".svelte-kit", "android", "ios", ".gradle", ".idea", ".vscode",
]);

const SOURCE_EXTS = new Set([
  ".js", ".ts", ".jsx", ".tsx", ".svelte", ".vue",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift",
  ".css", ".scss", ".less", ".html",
]);

const CONFIG_EXTS = new Set([".json", ".yaml", ".yml", ".toml"]);

const MAX_FILES = 400;
const MAX_DEPTH = 8;
const MAX_FILE_SIZE = 256 * 1024; // 256KB — skip huge files for import parsing

// ── Color palette ───────────────────────────────────────────────────────────

const PALETTE = [
  { primary: "#4493f8", mid: "#58a6ff", light: "#79c0ff" },   // blue
  { primary: "#ab7df8", mid: "#bc8cff", light: "#d2a8ff" },   // purple
  { primary: "#3fb950", mid: "#56d364", light: "#7ee787" },   // green
  { primary: "#f0883e", mid: "#f5a623", light: "#f8c96b" },   // orange
  { primary: "#f778ba", mid: "#ff9bce", light: "#ffbedd" },   // pink
  { primary: "#22d3ee", mid: "#67e8f9", light: "#a5f3fc" },   // cyan
  { primary: "#fbbf24", mid: "#fcd34d", light: "#fde68a" },   // amber
  { primary: "#a371f7", mid: "#bc8cff", light: "#d2a8ff" },   // violet
  { primary: "#ef4444", mid: "#f87171", light: "#fca5a5" },   // red
  { primary: "#38bdf8", mid: "#7dd3fc", light: "#bae6fd" },   // sky
];

// ── Import parsing ──────────────────────────────────────────────────────────

const IMPORT_PATTERNS = [
  // ES: import ... from '...'
  /import\s+(?:[\w{}\s,*]+\s+from\s+)?['"]([^'"]+)['"]/g,
  // require('...')
  /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // Dynamic import('...')
  /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  // Python: from x import y / import x
  /^(?:from\s+(\S+)\s+import|import\s+(\S+))/gm,
  // Go: import "..."
  /import\s+"([^"]+)"/g,
  // Svelte: <script> imports are captured by the ES pattern above
];

function parseImports(content, ext) {
  const imports = new Set();
  for (const pattern of IMPORT_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(content))) {
      // Pick the first non-undefined capture group
      const spec = m[1] ?? m[2];
      if (spec) imports.add(spec);
    }
  }
  return imports;
}

// ── File type detection ─────────────────────────────────────────────────────

function fileDesc(name, ext) {
  const base = basename(name, ext);
  if (ext === ".svelte") return "Svelte component";
  if (ext === ".vue") return "Vue component";
  if (ext === ".tsx" || ext === ".jsx") return "React component";
  if (ext === ".ts") return "TypeScript module";
  if (ext === ".js") return "JavaScript module";
  if (ext === ".py") return "Python module";
  if (ext === ".go") return "Go source";
  if (ext === ".rs") return "Rust source";
  if (ext === ".java" || ext === ".kt") return "JVM source";
  if (ext === ".css" || ext === ".scss" || ext === ".less") return "Stylesheet";
  if (ext === ".html") return "HTML template";
  if (ext === ".json") return "JSON config";
  if (ext === ".yaml" || ext === ".yml") return "YAML config";
  return "Source file";
}

function dirDesc(name, childCount) {
  const lower = name.toLowerCase();
  const suffix = `(${childCount} item${childCount !== 1 ? "s" : ""})`;
  if (lower === "components" || lower === "component") return `UI components ${suffix}`;
  if (lower === "routes" || lower === "pages") return `Route handlers ${suffix}`;
  if (lower === "lib" || lower === "utils" || lower === "helpers") return `Shared utilities ${suffix}`;
  if (lower === "stores" || lower === "store") return `State management ${suffix}`;
  if (lower === "hooks" || lower === "composables") return `Lifecycle hooks ${suffix}`;
  if (lower === "services" || lower === "api") return `Service layer ${suffix}`;
  if (lower === "models" || lower === "types" || lower === "schemas") return `Data models ${suffix}`;
  if (lower === "middleware") return `Middleware ${suffix}`;
  if (lower === "plugins") return `Plugin modules ${suffix}`;
  if (lower === "tests" || lower === "__tests__" || lower === "test") return `Test suites ${suffix}`;
  if (lower === "config" || lower === "configs") return `Configuration ${suffix}`;
  if (lower === "assets" || lower === "static" || lower === "public") return `Static assets ${suffix}`;
  if (lower === "styles" || lower === "css") return `Stylesheets ${suffix}`;
  if (lower === "layouts") return `Layout templates ${suffix}`;
  if (lower === "server" || lower === "backend") return `Server-side logic ${suffix}`;
  if (lower === "client" || lower === "frontend") return `Client-side code ${suffix}`;
  if (lower === "commands" || lower === "cmd") return `CLI commands ${suffix}`;
  return `Directory ${suffix}`;
}

// ── Scanner ─────────────────────────────────────────────────────────────────

/**
 * @param {string} projectDir — absolute path to the project root
 * @returns {Promise<{ tree: ArchNode, flows: Flow[] }>}
 */
export async function scanArchitecture(projectDir) {
  const files = [];
  const fileImports = new Map(); // relativePath → Set<importSpecifier>

  // Walk directory tree
  await walk(projectDir, "", 0);

  async function walk(dir, rel, depth) {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // permission denied, etc.
    }

    // Sort: directories first, then files
    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      const fullPath = join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(fullPath, relPath, depth + 1);
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (!SOURCE_EXTS.has(ext) && !CONFIG_EXTS.has(ext)) continue;
        // Skip config files at root (package.json, tsconfig, etc.) unless interesting
        if (CONFIG_EXTS.has(ext) && depth === 0) continue;

        files.push({ relPath, ext, fullPath });

        // Parse imports for source files
        if (SOURCE_EXTS.has(ext)) {
          try {
            const s = await stat(fullPath);
            if (s.size > MAX_FILE_SIZE) continue;
            const content = await readFile(fullPath, "utf-8");
            const imports = parseImports(content, ext);
            if (imports.size > 0) fileImports.set(relPath, imports);
          } catch {
            // skip unreadable
          }
        }
      }
    }
  }

  // Build directory tree from file paths
  const tree = buildDirectoryTree(projectDir, files);

  // Resolve imports into cross-group flows
  _groupDepthComputed = false;
  computeGroupDepth(files);
  const flows = resolveFlows(files, fileImports, projectDir);

  return { tree, flows };
}

// ── Tree builder ────────────────────────────────────────────────────────────

function buildDirectoryTree(projectDir, files) {
  const projectName = basename(projectDir);

  // Group files by their directory path segments
  const dirMap = new Map(); // dirPath → { files: [], subdirs: Set }

  for (const file of files) {
    const parts = file.relPath.split("/");
    const fileName = parts.pop();
    const dirPath = parts.join("/") || ".";

    if (!dirMap.has(dirPath)) {
      dirMap.set(dirPath, { files: [], subdirs: new Set() });
    }
    dirMap.get(dirPath).files.push({ name: fileName, ext: file.ext, relPath: file.relPath });

    // Register all parent directories
    for (let i = 1; i <= parts.length; i++) {
      const parent = parts.slice(0, i - 1).join("/") || ".";
      const child = parts.slice(0, i).join("/");
      if (!dirMap.has(parent)) dirMap.set(parent, { files: [], subdirs: new Set() });
      dirMap.get(parent).subdirs.add(child);
      if (!dirMap.has(child)) dirMap.set(child, { files: [], subdirs: new Set() });
    }
  }

  // Count top-level groups for color assignment
  const topLevelEntries = [];
  const rootInfo = dirMap.get(".") ?? { files: [], subdirs: new Set() };

  for (const subdir of rootInfo.subdirs) {
    topLevelEntries.push(subdir);
  }

  let colorIdx = 0;
  function nextColor() {
    const c = PALETTE[colorIdx % PALETTE.length];
    colorIdx++;
    return c;
  }

  // Recursively build ArchNode tree
  function buildNode(dirPath, name, colors, depth) {
    const info = dirMap.get(dirPath);
    if (!info) return null;

    const children = [];

    // Add subdirectories
    // Assign new colors at the top level AND at workspace boundaries
    // (e.g., packages/server and packages/ui should get distinct colors)
    const assignNewColors = depth === 0 ||
      (info.subdirs.size >= 2 && info.files.length <= 3);

    for (const subdir of [...info.subdirs].sort()) {
      const subdirName = subdir.split("/").pop();
      const childColors = assignNewColors ? nextColor() : colors;
      const child = buildNode(subdir, subdirName, childColors, depth + 1);
      if (child) children.push(child);
    }

    // Add files
    for (const file of info.files) {
      children.push({
        id: file.relPath,
        name: file.name,
        desc: fileDesc(file.name, file.ext),
        color: colors?.light ?? "#8b949e",
      });
    }

    if (children.length === 0) return null;

    // Collapse single-child directories (avoid long chains of dir → dir → dir)
    if (children.length === 1 && children[0].children?.length > 0 && info.files.length === 0) {
      const child = children[0];
      return {
        ...child,
        id: dirPath,
        name: `${name}/${child.name}`,
      };
    }

    const totalItems = children.length;

    return {
      id: dirPath,
      name,
      desc: dirDesc(name, totalItems),
      color: depth === 0 ? "#8b949e" : (colors?.primary ?? "#8b949e"),
      children,
    };
  }

  // Root has special color, children get palette colors
  const rootChildren = [];

  // Process top-level subdirectories
  for (const subdir of [...rootInfo.subdirs].sort()) {
    const subdirName = subdir.split("/").pop();
    const colors = nextColor();
    const child = buildNode(subdir, subdirName, colors, 1);
    if (child) {
      child.color = colors.primary;
      rootChildren.push(child);
    }
  }

  // Process root-level files
  for (const file of rootInfo.files) {
    rootChildren.push({
      id: file.relPath,
      name: file.name,
      desc: fileDesc(file.name, file.ext),
      color: "#8b949e",
    });
  }

  return {
    id: "root",
    name: projectName,
    desc: `Project root (${files.length} source files)`,
    color: "#8b949e",
    children: rootChildren,
  };
}

// ── Alias detection ─────────────────────────────────────────────────────────

function detectAliases(files) {
  const aliases = new Map();

  // Look for common SvelteKit/Vite/Next alias patterns
  const libDirs = files
    .filter(f => f.relPath.includes("/src/lib/") || f.relPath.includes("/src/utils/"))
    .map(f => {
      const match = f.relPath.match(/^(.+?)\/src\/lib\//);
      return match ? `${match[1]}/src/lib/` : null;
    })
    .filter(Boolean);

  // If we found lib dirs, register $lib as an alias
  if (libDirs.length > 0) {
    const uniqueDirs = [...new Set(libDirs)];
    for (const dir of uniqueDirs) {
      aliases.set("$lib/", dir);
    }
  }

  // Common aliases: @/ → src/, ~/  → src/
  const srcDirs = files.filter(f => f.relPath.includes("/src/")).map(f => {
    const match = f.relPath.match(/^(.+?)\/src\//);
    return match ? `${match[1]}/src/` : null;
  }).filter(Boolean);

  if (srcDirs.length > 0) {
    const unique = [...new Set(srcDirs)];
    for (const dir of unique) {
      aliases.set("@/", dir);
      aliases.set("~/", dir);
    }
  }

  return aliases;
}

// ── Flow resolver ───────────────────────────────────────────────────────────

function resolveFlows(files, fileImports, projectDir) {
  // Build a lookup from possible import specifiers to file relative paths
  const specToFile = new Map();

  for (const file of files) {
    const rel = file.relPath;
    const ext = file.ext;
    const noExt = rel.replace(/\.[^/.]+$/, "");

    // Register with and without extension
    specToFile.set(`./${rel}`, rel);
    specToFile.set(`./${noExt}`, rel);
    specToFile.set(rel, rel);
    specToFile.set(noExt, rel);

    // Also register index files as their directory
    if (basename(noExt) === "index") {
      const dir = dirname(rel);
      specToFile.set(`./${dir}`, rel);
      specToFile.set(dir, rel);
    }
  }

  // Detect common path aliases
  const aliases = detectAliases(files);

  // Collect all directory nodes that exist in the tree (for flow grouping)
  const dirNodes = new Set();
  for (const file of files) {
    const parts = file.relPath.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirNodes.add(parts.slice(0, i).join("/"));
    }
  }

  // Find the "interesting" grouping level: directories that have sibling directories
  // (i.e., directories that share a parent). These are the natural flow endpoints.
  function nearestGroupDir(filePath) {
    const parts = filePath.split("/");
    // Walk up from the file's parent directory
    for (let i = parts.length - 1; i >= 1; i--) {
      const candidate = parts.slice(0, i).join("/");
      const parent = parts.slice(0, i - 1).join("/") || ".";
      // Count sibling directories at this level
      let siblingCount = 0;
      for (const d of dirNodes) {
        if (dirname(d) === parent || (parent === "." && !d.includes("/"))) {
          siblingCount++;
        }
      }
      if (siblingCount >= 2) return candidate;
    }
    return topGroup(filePath);
  }

  // For each file's imports, resolve to actual project files and track cross-group edges
  const edgeCounts = new Map(); // "groupA→groupB" → count

  for (const [filePath, imports] of fileImports) {
    const fileDir = dirname(filePath);
    const fileGroup = nearestGroupDir(filePath);

    for (const spec of imports) {
      let target = null;

      if (spec.startsWith(".") || spec.startsWith("/")) {
        // Relative import
        const resolved = resolveRelative(fileDir, spec);
        target = specToFile.get(resolved) ?? specToFile.get(`./${resolved}`);
      } else {
        // Try alias resolution (e.g. $lib/api → packages/ui/src/lib/api)
        for (const [prefix, replacement] of aliases) {
          if (spec.startsWith(prefix)) {
            const resolved = spec.replace(prefix, replacement);
            target = specToFile.get(resolved) ?? specToFile.get(`./${resolved}`);
            if (target) break;
          }
        }
      }

      if (!target) continue;

      const targetGroup = nearestGroupDir(target);
      if (fileGroup && targetGroup && fileGroup !== targetGroup) {
        const key = `${fileGroup}→${targetGroup}`;
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }
  }

  // Convert to flow objects
  const flows = [];
  for (const [key, count] of edgeCounts) {
    const [from, to] = key.split("→");
    flows.push({
      from,
      to,
      label: `${count} import${count !== 1 ? "s" : ""}`,
    });
  }

  // Sort by count descending, limit to most significant flows
  flows.sort((a, b) => {
    const countA = edgeCounts.get(`${a.from}→${a.to}`) ?? 0;
    const countB = edgeCounts.get(`${b.from}→${b.to}`) ?? 0;
    return countB - countA;
  });

  return flows.slice(0, 15);
}

// Monorepo-aware grouping: if all files share a common container directory
// (like "packages/", "apps/", "libs/"), use the second level as the group.
// This is computed once per scan and memoized.
let _groupDepth = 0;
let _groupDepthComputed = false;

function computeGroupDepth(files) {
  if (_groupDepthComputed) return;
  _groupDepthComputed = true;

  if (files.length < 2) { _groupDepth = 0; return; }

  const CONTAINER_NAMES = new Set([
    "packages", "apps", "libs", "modules", "workspace", "workspaces",
    "services", "projects", "src",
  ]);

  // Check if the top-level segment is a known container
  const topSegments = new Set(files.map(f => f.relPath.split("/")[0]));
  if (topSegments.size <= 3) {
    for (const seg of topSegments) {
      if (CONTAINER_NAMES.has(seg.toLowerCase())) {
        _groupDepth = 1;
        return;
      }
    }
  }
}

function topGroup(relPath) {
  const parts = relPath.split("/");
  if (_groupDepth > 0 && parts.length > _groupDepth + 1) {
    return parts.slice(0, _groupDepth + 1).join("/");
  }
  return parts[0] || null;
}

function resolveRelative(fromDir, specifier) {
  const parts = fromDir.split("/").filter(Boolean);
  const specParts = specifier.split("/");

  for (const seg of specParts) {
    if (seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }

  return parts.join("/");
}

// ── In-memory cache (projectDir → { result, timestamp }) ────────────────────

const cache = new Map();
const CACHE_TTL = 30_000; // 30 seconds

export async function getArchitecture(projectDir) {
  const now = Date.now();
  const cached = cache.get(projectDir);
  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.result;
  }

  const result = await scanArchitecture(projectDir);
  cache.set(projectDir, { result, timestamp: now });
  return result;
}
