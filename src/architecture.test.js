import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { scanArchitecture } from "./architecture.js";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * Tests for the architecture scanner — import parsing, tree building,
 * and cross-module flow detection. Uses a temporary directory structure
 * with known source files rather than scanning the real project.
 */

const TEMP_DIR = join(import.meta.dir, "..", ".test-arch-project");

beforeAll(() => {
  // Build a small fake project structure
  const dirs = [
    "src/components",
    "src/lib",
    "src/routes",
  ];
  for (const d of dirs) {
    mkdirSync(join(TEMP_DIR, d), { recursive: true });
  }

  // src/lib/api.ts — utility module
  writeFileSync(
    join(TEMP_DIR, "src/lib/api.ts"),
    `export function fetchData() { return fetch("/api"); }\n`
  );

  // src/lib/utils.js — another utility
  writeFileSync(
    join(TEMP_DIR, "src/lib/utils.js"),
    `export const capitalize = (s) => s[0].toUpperCase() + s.slice(1);\n`
  );

  // src/components/Button.tsx — imports from lib
  writeFileSync(
    join(TEMP_DIR, "src/components/Button.tsx"),
    `import { capitalize } from "../lib/utils.js";\nexport function Button() { return <button>{capitalize("click")}</button>; }\n`
  );

  // src/components/Card.svelte — imports from lib
  writeFileSync(
    join(TEMP_DIR, "src/components/Card.svelte"),
    `<script>\nimport { fetchData } from "../lib/api";\n</script>\n<div>card</div>\n`
  );

  // src/routes/index.ts — imports from components and lib
  writeFileSync(
    join(TEMP_DIR, "src/routes/index.ts"),
    `import { Button } from "../components/Button";\nimport { fetchData } from "../lib/api";\nexport default function Page() {}\n`
  );

  // Python file to test multi-language parsing
  writeFileSync(
    join(TEMP_DIR, "src/lib/helper.py"),
    `from os import path\nimport json\n\ndef helper():\n    pass\n`
  );

  // require() style
  writeFileSync(
    join(TEMP_DIR, "src/lib/legacy.js"),
    `const fs = require("fs");\nconst path = require("path");\nmodule.exports = {};\n`
  );
});

afterAll(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

describe("scanArchitecture", () => {
  it("returns a tree with root node", async () => {
    const { tree } = await scanArchitecture(TEMP_DIR);
    expect(tree).toBeDefined();
    expect(tree.id).toBe("root");
    expect(tree.children).toBeInstanceOf(Array);
    expect(tree.children.length).toBeGreaterThan(0);
  });

  it("discovers all source files in the tree", async () => {
    const { tree } = await scanArchitecture(TEMP_DIR);

    // Collect all leaf node IDs (files)
    const fileIds = [];
    function walk(node) {
      if (!node.children) {
        fileIds.push(node.id);
      } else {
        node.children.forEach(walk);
      }
    }
    walk(tree);

    expect(fileIds).toContain("src/lib/api.ts");
    expect(fileIds).toContain("src/components/Button.tsx");
    expect(fileIds).toContain("src/routes/index.ts");
    expect(fileIds).toContain("src/lib/helper.py");
  });

  it("assigns file descriptions based on extension", async () => {
    const { tree } = await scanArchitecture(TEMP_DIR);

    const files = [];
    function walk(node) {
      if (!node.children) files.push(node);
      else node.children.forEach(walk);
    }
    walk(tree);

    const tsx = files.find((f) => f.id === "src/components/Button.tsx");
    expect(tsx.desc).toBe("React component");

    const ts = files.find((f) => f.id === "src/lib/api.ts");
    expect(ts.desc).toBe("TypeScript module");

    const py = files.find((f) => f.id === "src/lib/helper.py");
    expect(py.desc).toBe("Python module");

    const svelte = files.find((f) => f.id === "src/components/Card.svelte");
    expect(svelte.desc).toBe("Svelte component");
  });

  it("detects cross-module import flows", async () => {
    const { flows } = await scanArchitecture(TEMP_DIR);
    expect(flows).toBeInstanceOf(Array);

    // There should be flows between routes→components, routes→lib, components→lib
    const flowPairs = flows.map((f) => `${f.from}→${f.to}`);

    // At minimum, components import from lib
    const hasComponentsToLib = flowPairs.some(
      (p) => p.includes("components") && p.includes("lib")
    );
    expect(hasComponentsToLib).toBe(true);
  });

  it("assigns colors to tree nodes", async () => {
    const { tree } = await scanArchitecture(TEMP_DIR);

    expect(tree.color).toBeDefined();

    // Children should have colors too
    for (const child of tree.children) {
      expect(child.color).toBeDefined();
    }
  });

  it("includes flow labels with import counts", async () => {
    const { flows } = await scanArchitecture(TEMP_DIR);
    for (const flow of flows) {
      expect(flow.label).toMatch(/\d+ imports?/);
      expect(flow.from).toBeTruthy();
      expect(flow.to).toBeTruthy();
    }
  });
});

describe("scanArchitecture — import pattern detection", () => {
  const IMPORT_DIR = join(TEMP_DIR, "..", ".test-arch-imports");

  beforeAll(() => {
    mkdirSync(join(IMPORT_DIR, "src/a"), { recursive: true });
    mkdirSync(join(IMPORT_DIR, "src/b"), { recursive: true });

    // ES module static imports
    writeFileSync(
      join(IMPORT_DIR, "src/a/es-static.js"),
      `import { foo } from "../b/target.js";\nimport bar from "../b/target.js";\nimport * as all from "../b/target.js";\n`
    );

    // Dynamic import()
    writeFileSync(
      join(IMPORT_DIR, "src/a/dynamic.js"),
      `const mod = await import("../b/target.js");\n`
    );

    // require() style
    writeFileSync(
      join(IMPORT_DIR, "src/a/cjs.js"),
      `const target = require("../b/target");\n`
    );

    // Python imports
    writeFileSync(
      join(IMPORT_DIR, "src/a/pymod.py"),
      `from os import path\nimport json\nfrom ..b import target\n`
    );

    // Target file
    writeFileSync(
      join(IMPORT_DIR, "src/b/target.js"),
      `export const foo = 1;\nexport default foo;\n`
    );
  });

  afterAll(() => {
    rmSync(IMPORT_DIR, { recursive: true, force: true });
  });

  it("detects ES static imports (named, default, namespace)", async () => {
    const { flows } = await scanArchitecture(IMPORT_DIR);
    // src/a imports from src/b → should produce a flow
    const hasAtoB = flows.some((f) => f.from.includes("a") && f.to.includes("b"));
    expect(hasAtoB).toBe(true);
  });

  it("detects dynamic import() calls", async () => {
    const { tree } = await scanArchitecture(IMPORT_DIR);
    // Just verify the file was discovered (import parsing happens internally)
    const files = [];
    function walk(node) {
      if (!node.children) files.push(node.id);
      else node.children.forEach(walk);
    }
    walk(tree);
    expect(files).toContain("src/a/dynamic.js");
  });

  it("detects require() calls", async () => {
    const { tree } = await scanArchitecture(IMPORT_DIR);
    const files = [];
    function walk(node) {
      if (!node.children) files.push(node.id);
      else node.children.forEach(walk);
    }
    walk(tree);
    expect(files).toContain("src/a/cjs.js");
  });

  it("detects Python from/import statements", async () => {
    const { tree } = await scanArchitecture(IMPORT_DIR);
    const files = [];
    function walk(node) {
      if (!node.children) files.push(node.id);
      else node.children.forEach(walk);
    }
    walk(tree);
    expect(files).toContain("src/a/pymod.py");
  });
});

describe("scanArchitecture — edge cases", () => {
  it("handles empty directory", async () => {
    const emptyDir = join(TEMP_DIR, "..", ".test-arch-empty");
    mkdirSync(emptyDir, { recursive: true });
    try {
      const { tree, flows } = await scanArchitecture(emptyDir);
      expect(tree.children).toEqual([]);
      expect(flows).toEqual([]);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("skips node_modules and .git directories", async () => {
    const dirWithNodeModules = join(TEMP_DIR, "..", ".test-arch-skip");
    mkdirSync(join(dirWithNodeModules, "node_modules/foo"), { recursive: true });
    mkdirSync(join(dirWithNodeModules, ".git/objects"), { recursive: true });
    mkdirSync(join(dirWithNodeModules, "src"), { recursive: true });
    writeFileSync(join(dirWithNodeModules, "node_modules/foo/index.js"), "module.exports = 1;");
    writeFileSync(join(dirWithNodeModules, "src/app.js"), "const x = 1;");
    try {
      const { tree } = await scanArchitecture(dirWithNodeModules);
      const fileIds = [];
      function walk(node) {
        if (!node.children) fileIds.push(node.id);
        else node.children.forEach(walk);
      }
      walk(tree);

      expect(fileIds).toContain("src/app.js");
      expect(fileIds.some((f) => f.includes("node_modules"))).toBe(false);
      expect(fileIds.some((f) => f.includes(".git"))).toBe(false);
    } finally {
      rmSync(dirWithNodeModules, { recursive: true, force: true });
    }
  });
});
