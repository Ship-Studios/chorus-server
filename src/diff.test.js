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

  // ─── /dev/null handling ──────────────────────────────────────────

  it("uses newFileName for old when old is /dev/null (new file)", () => {
    const diff = `diff --git a/added.ts b/added.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/added.ts
@@ -0,0 +1 @@
+export const x = 1;
`;
    const files = parseDiffToFiles(diff);
    // --- /dev/null doesn't start with "--- a/", so oldFileName falls back
    expect(files[0].newFileName).toBe("added.ts");
  });

  it("uses oldFileName for new when new is /dev/null (deleted file)", () => {
    const diff = `diff --git a/gone.js b/gone.js
deleted file mode 100644
index abc1234..0000000
--- a/gone.js
+++ /dev/null
@@ -1 +0,0 @@
-const bye = true;
`;
    const files = parseDiffToFiles(diff);
    // +++ /dev/null doesn't start with "+++ b/", so newFileName falls back
    expect(files[0].oldFileName).toBe("gone.js");
  });

  // ─── Header fallback path ────────────────────────────────────────

  it("falls back to parsing header when --- / +++ lines are missing", () => {
    // Some binary diffs or mode-only changes have no --- / +++ lines
    const diff = `diff --git a/config.bin b/config.bin
similarity index 100%
rename from old-config.bin
rename to config.bin
`;
    const files = parseDiffToFiles(diff);
    expect(files).toHaveLength(1);
    // Falls back to parsing from the "diff --git a/... b/..." header
    expect(files[0].oldFileName).toBe("config.bin");
    expect(files[0].newFileName).toBe("config.bin");
  });

  // ─── Deeply nested paths ─────────────────────────────────────────

  it("handles deeply nested file paths", () => {
    const diff = `diff --git a/packages/server/src/routes/sessions.js b/packages/server/src/routes/sessions.js
index aaa..bbb 100644
--- a/packages/server/src/routes/sessions.js
+++ b/packages/server/src/routes/sessions.js
@@ -1 +1 @@
-old
+new
`;
    const files = parseDiffToFiles(diff);
    expect(files[0].oldFileName).toBe("packages/server/src/routes/sessions.js");
    expect(files[0].newFileName).toBe("packages/server/src/routes/sessions.js");
  });

  // ─── Multiple hunks spread across files ──────────────────────────

  it("correctly separates hunks across multiple files in a single diff", () => {
    const diff = `diff --git a/a.js b/a.js
index aaa..bbb 100644
--- a/a.js
+++ b/a.js
@@ -1,2 +1,3 @@
 line1
+added
 line2
@@ -10,2 +11,3 @@
 line10
+also added
 line11
diff --git a/b.js b/b.js
index ccc..ddd 100644
--- a/b.js
+++ b/b.js
@@ -1 +1,2 @@
 only line
+another
`;
    const files = parseDiffToFiles(diff);
    expect(files).toHaveLength(2);
    expect(files[0].hunkCount).toBe(2);
    expect(files[1].hunkCount).toBe(1);
    // Each file's hunks array should contain the full diff chunk for that file
    expect(files[0].hunks[0]).toContain("a.js");
    expect(files[0].hunks[0]).not.toContain("b.js");
    expect(files[1].hunks[0]).toContain("b.js");
    expect(files[1].hunks[0]).not.toContain("a.js");
  });

  // ─── Whitespace-only diff input ──────────────────────────────────

  it("returns empty array for whitespace-only input variants", () => {
    expect(parseDiffToFiles("\n")).toEqual([]);
    expect(parseDiffToFiles("\t")).toEqual([]);
    expect(parseDiffToFiles("  \n  \n  ")).toEqual([]);
  });

  // ─── Additional language detection ────────────────────────────────

  it("detects Kotlin, Swift, C#, and Less file languages", () => {
    const makeDiff = (file) =>
      `diff --git a/${file} b/${file}\nindex aaa..bbb 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`;

    const cases = [
      ["Main.kt", "kotlin"],
      ["App.swift", "swift"],
      ["Service.cs", "csharp"],
      ["theme.less", "less"],
      ["App.vue", "vue"],
    ];

    for (const [file, lang] of cases) {
      const files = parseDiffToFiles(makeDiff(file));
      expect(files[0].fileLang).toBe(lang);
    }
  });
});
