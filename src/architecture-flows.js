import { dirname } from "node:path";

export function detectAliases(files) {
  const aliases = new Map();

  const libDirs = files
    .filter((f) => f.relPath.includes("/src/lib/") || f.relPath.includes("/src/utils/"))
    .map((f) => {
      const match = f.relPath.match(/^(.+?)\\/src\\/lib\\//);
      return match ? `${match[1]}/src/lib/` : null;
    })
    .filter(Boolean);

  if (libDirs.length > 0) {
    const uniqueDirs = [...new Set(libDirs)];
    for (const dir of uniqueDirs) {
      aliases.set("$lib/", dir);
    }
  }

  const srcDirs = files
    .filter((f) => f.relPath.includes("/src/"))
    .map((f) => {
      const match = f.relPath.match(/^(.+?)\\/src\\//);
      return match ? `${match[1]}/src/` : null;
    })
    .filter(Boolean);

  if (srcDirs.length > 0) {
    const unique = [...new Set(srcDirs)];
    for (const dir of unique) {
      aliases.set("@/", dir);
      aliases.set("~/", dir);
    }
  }

  return aliases;
}

function computeGroupDepth(files) {
  if (files.length < 2) return 0;

  const CONTAINER_NAMES = new Set([
    "packages", "apps", "libs", "modules", "workspace", "workspaces",
    "services", "projects", "src",
  ]);

  const topSegments = new Set(files.map((f) => f.relPath.split("/")[0]));
  if (topSegments.size <= 3) {
    for (const seg of topSegments) {
      if (CONTAINER_NAMES.has(seg.toLowerCase())) return 1;
    }
  }

  return 0;
}

function topGroup(relPath, groupDepth) {
  const parts = relPath.split("/");
  if (groupDepth > 0 && parts.length > groupDepth + 1) {
    return parts.slice(0, groupDepth + 1).join("/");
  }
  return parts[0] || null;
}

function nearestGroupDir(filePath, dirNodes, groupDepth) {
  const parts = filePath.split("/");
  for (let i = parts.length - 1; i >= 1; i--) {
    const candidate = parts.slice(0, i).join("/");
    const parent = parts.slice(0, i - 1).join("/") || ".";
    let siblingCount = 0;
    for (const d of dirNodes) {
      if (dirname(d) === parent || (parent === "." && !d.includes("/"))) {
        siblingCount++;
      }
    }
    if (siblingCount >= 2) return candidate;
  }
  return topGroup(filePath, groupDepth);
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

export function resolveFlows(files, fileImports, _projectDir) {
  const specToFile = new Map();
  for (const file of files) {
    const rel = file.relPath;
    const ext = file.ext;
    const noExt = rel.replace(/\\.[^/.]+$/, "");

    specToFile.set(`./${rel}`, rel);
    specToFile.set(`./${noExt}`, rel);
    specToFile.set(rel, rel);
    specToFile.set(noExt, rel);

    if (rel.endsWith("/index" + ext)) {
      const dir = dirname(rel);
      specToFile.set(`./${dir}`, rel);
      specToFile.set(dir, rel);
    }
  }

  const aliases = detectAliases(files);

  const dirNodes = new Set();
  for (const file of files) {
    const parts = file.relPath.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirNodes.add(parts.slice(0, i).join("/"));
    }
  }

  const groupDepth = computeGroupDepth(files);
  const edgeCounts = new Map();

  for (const [filePath, imports] of fileImports) {
    const fileDir = dirname(filePath);
    const fileGroup = nearestGroupDir(filePath, dirNodes, groupDepth);

    for (const spec of imports) {
      let target = null;

      if (spec.startsWith(".") || spec.startsWith("/")) {
        const resolved = resolveRelative(fileDir, spec);
        target = specToFile.get(resolved) ?? specToFile.get(`./${resolved}`);
      } else {
        for (const [prefix, replacement] of aliases) {
          if (spec.startsWith(prefix)) {
            const resolved = spec.replace(prefix, replacement);
            target = specToFile.get(resolved) ?? specToFile.get(`./${resolved}`);
            if (target) break;
          }
        }
      }

      if (!target) continue;

      const targetGroup = nearestGroupDir(target, dirNodes, groupDepth);
      if (fileGroup && targetGroup && fileGroup !== targetGroup) {
        const key = `${fileGroup}→${targetGroup}`;
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const flows = [];
  for (const [key, count] of edgeCounts) {
    const [from, to] = key.split("→");
    flows.push({ from, to, label: `${count} import${count !== 1 ? "s" : ""}` });
  }

  flows.sort((a, b) => {
    const countA = edgeCounts.get(`${a.from}→${a.to}`) ?? 0;
    const countB = edgeCounts.get(`${b.from}→${b.to}`) ?? 0;
    return countB - countA;
  });

  return flows.slice(0, 15);
}
