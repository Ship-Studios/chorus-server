import { basename } from "node:path";
import { dirDesc, fileDesc } from "./architecture-parsers.js";

export const PALETTE = [
  { primary: "#4493f8", mid: "#58a6ff", light: "#79c0ff" },
  { primary: "#ab7df8", mid: "#bc8cff", light: "#d2a8ff" },
  { primary: "#3fb950", mid: "#56d364", light: "#7ee787" },
  { primary: "#f0883e", mid: "#f5a623", light: "#f8c96b" },
  { primary: "#f778ba", mid: "#ff9bce", light: "#ffbedd" },
  { primary: "#22d3ee", mid: "#67e8f9", light: "#a5f3fc" },
  { primary: "#fbbf24", mid: "#fcd34d", light: "#fde68a" },
  { primary: "#a371f7", mid: "#bc8cff", light: "#d2a8ff" },
  { primary: "#ef4444", mid: "#f87171", light: "#fca5a5" },
  { primary: "#38bdf8", mid: "#7dd3fc", light: "#bae6fd" },
];

export function buildDirectoryTree(projectDir, files) {
  const projectName = basename(projectDir);
  const dirMap = new Map();

  for (const file of files) {
    const parts = file.relPath.split("/");
    const fileName = parts.pop();
    const dirPath = parts.join("/") || ".";

    if (!dirMap.has(dirPath)) {
      dirMap.set(dirPath, { files: [], subdirs: new Set() });
    }
    dirMap.get(dirPath).files.push({ name: fileName, ext: file.ext, relPath: file.relPath });

    for (let i = 1; i <= parts.length; i++) {
      const parent = parts.slice(0, i - 1).join("/") || ".";
      const child = parts.slice(0, i).join("/");
      if (!dirMap.has(parent)) dirMap.set(parent, { files: [], subdirs: new Set() });
      dirMap.get(parent).subdirs.add(child);
      if (!dirMap.has(child)) dirMap.set(child, { files: [], subdirs: new Set() });
    }
  }

  const rootInfo = dirMap.get(".") ?? { files: [], subdirs: new Set() };

  let colorIdx = 0;
  function nextColor() {
    const c = PALETTE[colorIdx % PALETTE.length];
    colorIdx++;
    return c;
  }

  function buildNode(dirPath, name, colors, depth) {
    const info = dirMap.get(dirPath);
    if (!info) return null;

    const children = [];
    const assignNewColors = depth === 0 || (info.subdirs.size >= 2 && info.files.length <= 3);

    for (const subdir of [...info.subdirs].sort()) {
      const subdirName = subdir.split("/").pop();
      const childColors = assignNewColors ? nextColor() : colors;
      const child = buildNode(subdir, subdirName, childColors, depth + 1);
      if (child) children.push(child);
    }

    for (const file of info.files) {
      children.push({
        id: file.relPath,
        name: file.name,
        desc: fileDesc(file.name, file.ext),
        color: colors?.light ?? "#8b949e",
      });
    }

    if (children.length === 0) return null;

    if (children.length === 1 && children[0].children?.length > 0 && info.files.length === 0) {
      const child = children[0];
      return { ...child, id: dirPath, name: `${name}/${child.name}` };
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

  const rootChildren = [];
  for (const subdir of [...rootInfo.subdirs].sort()) {
    const subdirName = subdir.split("/").pop();
    const colors = nextColor();
    const child = buildNode(subdir, subdirName, colors, 1);
    if (child) {
      child.color = colors.primary;
      rootChildren.push(child);
    }
  }

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
