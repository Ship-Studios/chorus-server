export const COMMIT_MSG_SYSTEM_PROMPT =
  "You generate git commit messages following the Conventional Commits format. " +
  "Analyze the diff and produce a commit message with:\n" +
  "- A type prefix: feat, fix, refactor, docs, chore, style, test, perf, ci, build\n" +
  "- An optional scope in parentheses if changes are focused on a specific area\n" +
  "- A concise subject line (under 72 characters) in imperative mood\n" +
  "- An optional body (separated by a blank line) with 1-3 bullet points explaining key changes, only if the change is non-trivial\n" +
  "Return ONLY the commit message text, no markdown formatting, no code fences, no explanation.";

export function buildCommitPrompt(stat, diff) {
  return (
    "Generate a commit message for this diff.\n\n" +
    `<stat>\n${stat}\n</stat>\n\n` +
    `<diff>\n${diff}\n</diff>`
  );
}

export const SUBMODULE_COMMIT_MSG_SYSTEM_PROMPT =
  "You generate git commit messages for a monorepo with submodules. " +
  "You will receive diffs from multiple scopes (submodules + parent repo). " +
  "Generate a SEPARATE commit message for each scope.\n\n" +
  "Rules:\n" +
  "- Each message follows Conventional Commits: type(scope): subject\n" +
  "- Subject line under 72 characters, imperative mood\n" +
  "- Optional body with 1-3 bullet points for non-trivial changes\n" +
  "- The parent message should summarize the overall change and mention submodule updates\n\n" +
  "Return a JSON object with keys matching the scope names, each value being the commit message string.\n" +
  "Example: {\"packages/server\": \"feat: add VPN proxy support\", \"parent\": \"feat: VPN proxy support\"}\n" +
  "Return ONLY the JSON object, no markdown, no code fences.";

export function buildSubmoduleCommitPrompt(scopes) {
  const parts = ["Generate a commit message for each of the following scopes.\n"];
  for (const { name, stat, diff } of scopes) {
    parts.push(`<scope name=\"${name}\">\n<stat>\n${stat}\n</stat>\n<diff>\n${diff}\n</diff>\n</scope>\n`);
  }
  return parts.join("\n");
}
