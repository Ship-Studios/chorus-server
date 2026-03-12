/**
 * Splits a raw unified diff into per-file entries with hunks arrays,
 * compatible with @git-diff-view/svelte's `data` prop.
 */
export function parseDiffToFiles(rawDiff) {
  if (!rawDiff || !rawDiff.trim()) return [];

  // Strip submodule header lines injected by --submodule=diff
  rawDiff = rawDiff.replace(/^Submodule \S+ contains (?:modified|untracked) content\n/gm, "");

  const fileChunks = rawDiff.split(/^(?=diff --git )/m).filter(Boolean);

  return fileChunks.map((chunk) => {
    const lines = chunk.split("\n");

    // Extract file names from --- and +++ lines (handles spaces in paths).
    // Falls back to the diff --git header if --- / +++ are missing.
    const oldLine = lines.find((l) => l.startsWith("--- a/"));
    const newLine = lines.find((l) => l.startsWith("+++ b/"));
    let oldFileName = oldLine ? oldLine.slice(6) : "";
    let newFileName = newLine ? newLine.slice(6) : "";

    // Fallback: parse from header (less reliable with spaces)
    if (!oldFileName && !newFileName) {
      const headerLine = lines[0] || "";
      const oldMatch = headerLine.match(/a\/(.+?) b\//);
      const newMatch = headerLine.match(/b\/(.+)$/);
      oldFileName = oldMatch?.[1] ?? "";
      newFileName = newMatch?.[1] ?? oldFileName;
    }
    if (!oldFileName) oldFileName = newFileName;

    // Detect file language from extension
    const ext = newFileName.split(".").pop()?.toLowerCase() ?? "";
    const langMap = {
      js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx",
      py: "python", rb: "ruby", go: "go", rs: "rust",
      java: "java", kt: "kotlin", swift: "swift", cs: "csharp",
      css: "css", scss: "scss", less: "less",
      html: "xml", svelte: "xml", vue: "vue",
      json: "json", yaml: "yaml", yml: "yaml", toml: "ini",
      md: "markdown", sql: "sql", sh: "bash", bash: "bash",
      dockerfile: "dockerfile", xml: "xml",
    };
    const fileLang = langMap[ext] ?? "plaintext";

    // Count hunks for display (each starts with @@)
    const hunkCount = lines.filter((l) => l.startsWith("@@")).length;

    // Pass the entire file diff as a single string — @git-diff-view/core
    // expects each hunks[] entry to be a complete unified diff including
    // the diff --git, ---, +++ header lines. It parses hunks internally.
    return {
      oldFileName,
      newFileName,
      fileLang,
      hunks: [chunk],
      hunkCount,
    };
  });
}

/**
 * Builds a git-stat-style summary string from parsed diff files.
 * The UI extracts totals via /(\d+) insertion/ and /(\d+) deletion/ regexes.
 */
export function buildStatSummary(files) {
  if (!files.length) return "";

  let totalIns = 0;
  let totalDel = 0;
  const lines = [];

  for (const f of files) {
    const chunk = f.hunks[0] || "";
    const ins = (chunk.match(/^\+([^+]|$)/gm) || []).length;
    const del = (chunk.match(/^-([^-]|$)/gm) || []).length;
    totalIns += ins;
    totalDel += del;
    const name = f.newFileName || f.oldFileName;
    lines.push(` ${name} | ${ins + del}`);
  }

  const fc = files.length;
  lines.push(` ${fc} file${fc !== 1 ? "s" : ""} changed, ${totalIns} insertion${totalIns !== 1 ? "s" : ""}(+), ${totalDel} deletion${totalDel !== 1 ? "s" : ""}(-)`);
  return lines.join("\n");
}
