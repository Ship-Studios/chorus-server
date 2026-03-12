import { describe, expect, it } from "bun:test";
import { parseDiffToFiles } from "./diff.js";

// ─── parseDiffToFiles ───────────────────────────────────────────────────────

describe("parseDiffToFiles", () => {
  it("returns empty array for null/undefined/empty input", () => {
    expect(parseDiffToFiles(null)).toEqual([]);
    expect(parseDiffToFiles(undefined)).toEqual([]);
    expect(parseDiffToFiles("")).toEqual([]);
    expect(parseDiffToFiles("   ")).toEqual([]);
  });

  it("parses a single-file diff", () => {
    const diff = `diff --git a/src/index.js b/src/index.js
index abc1234..def5678 100644
--- a/src/index.js
+++ b/src/index.js
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
`;
    const files = parseDiffToFiles(diff);
    expect(files).toHaveLength(1);
    expect(files[0].oldFileName).toBe("src/index.js");
    expect(files[0].newFileName).toBe("src/index.js");
    expect(files[0].fileLang).toBe("javascript");
    expect(files[0].hunkCount).toBe(1);
    expect(files[0].hunks).toHaveLength(1);
    expect(files[0].hunks[0]).toContain("diff --git");
  });

  it("parses a multi-file diff", () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index aaa..bbb 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,2 +1,3 @@
 export const x = 1;
+export const y = 2;
diff --git a/src/bar.py b/src/bar.py
index ccc..ddd 100644
--- a/src/bar.py
+++ b/src/bar.py
@@ -10,3 +10,4 @@
 def hello():
+    print("world")
     pass
`;
    const files = parseDiffToFiles(diff);
    expect(files).toHaveLength(2);
    expect(files[0].newFileName).toBe("src/foo.ts");
    expect(files[0].fileLang).toBe("typescript");
    expect(files[1].newFileName).toBe("src/bar.py");
    expect(files[1].fileLang).toBe("python");
  });

  it("detects correct file languages from extensions", () => {
    const makeDiff = (file) =>
      `diff --git a/${file} b/${file}\nindex aaa..bbb 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`;

    const testCases = [
      ["app.jsx", "jsx"],
      ["page.tsx", "tsx"],
      ["main.go", "go"],
      ["lib.rs", "rust"],
      ["App.java", "java"],
      ["style.css", "css"],
      ["style.scss", "scss"],
      ["page.html", "xml"],
      ["App.svelte", "xml"],
      ["data.json", "json"],
      ["config.yaml", "yaml"],
      ["config.yml", "yaml"],
      ["setup.toml", "ini"],
      ["README.md", "markdown"],
      ["query.sql", "sql"],
      ["run.sh", "bash"],
      ["Dockerfile", "dockerfile"],
    ];

    for (const [file, expectedLang] of testCases) {
      const files = parseDiffToFiles(makeDiff(file));
      expect(files[0].fileLang).toBe(expectedLang);
    }
  });

  it("falls back to plaintext for unknown extensions", () => {
    const diff = `diff --git a/data.xyz b/data.xyz
index aaa..bbb 100644
--- a/data.xyz
+++ b/data.xyz
@@ -1 +1 @@
-old
+new
`;
    const files = parseDiffToFiles(diff);
    expect(files[0].fileLang).toBe("plaintext");
  });

  it("counts multiple hunks in a single file", () => {
    const diff = `diff --git a/src/app.js b/src/app.js
index aaa..bbb 100644
--- a/src/app.js
+++ b/src/app.js
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
@@ -20,3 +21,4 @@
 function foo() {}
+function bar() {}
 export default foo;
@@ -50,2 +52,3 @@
 // end
+// really end
`;
    const files = parseDiffToFiles(diff);
    expect(files[0].hunkCount).toBe(3);
  });

  it("handles file renames (different a/ and b/ paths)", () => {
    const diff = `diff --git a/old-name.js b/new-name.js
similarity index 95%
rename from old-name.js
rename to new-name.js
index aaa..bbb 100644
--- a/old-name.js
+++ b/new-name.js
@@ -1 +1 @@
-const x = 1;
+const x = 2;
`;
    const files = parseDiffToFiles(diff);
    expect(files[0].oldFileName).toBe("old-name.js");
    expect(files[0].newFileName).toBe("new-name.js");
  });

  it("handles new file (no old content)", () => {
    const diff = `diff --git a/brand-new.ts b/brand-new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/brand-new.ts
@@ -0,0 +1,3 @@
+export const hello = "world";
+export const foo = "bar";
+export const baz = 42;
`;
    const files = parseDiffToFiles(diff);
    expect(files).toHaveLength(1);
    expect(files[0].newFileName).toBe("brand-new.ts");
    expect(files[0].fileLang).toBe("typescript");
    expect(files[0].hunkCount).toBe(1);
  });

  it("handles deleted file", () => {
    const diff = `diff --git a/removed.js b/removed.js
deleted file mode 100644
index abc1234..0000000
--- a/removed.js
+++ /dev/null
@@ -1,2 +0,0 @@
-const old = true;
-export default old;
`;
    const files = parseDiffToFiles(diff);
    expect(files).toHaveLength(1);
    expect(files[0].oldFileName).toBe("removed.js");
  });

  it("handles binary files gracefully", () => {
    const diff = `diff --git a/image.png b/image.png
new file mode 100644
index 0000000..abc1234
Binary files /dev/null and b/image.png differ
`;
    const files = parseDiffToFiles(diff);
    expect(files).toHaveLength(1);
    expect(files[0].newFileName).toBe("image.png");
    expect(files[0].hunkCount).toBe(0); // No @@ lines
  });

  it("handles file paths with spaces correctly via --- / +++ lines", () => {
    const diff = `diff --git a/my folder/file name.js b/my folder/file name.js
index aaa..bbb 100644
--- a/my folder/file name.js
+++ b/my folder/file name.js
@@ -1 +1 @@
-old
+new
`;
    const files = parseDiffToFiles(diff);
    expect(files[0].oldFileName).toBe("my folder/file name.js");
    expect(files[0].newFileName).toBe("my folder/file name.js");
  });
});
