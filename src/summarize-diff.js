/**
 * Re-exports from @chorus/diff-panel.
 * Canonical source lives in packages/diff-panel/src/server/summarize-diff.js.
 */
export {
  summarizeDiff,
  truncateDiff,
  buildUserPrompt,
  MAX_DIFF_CHARS,
  MAX_SUMMARY_CHARS,
  DEFAULT_MODEL,
  SYSTEM_PROMPT,
} from "@chorus/diff-panel/server";
