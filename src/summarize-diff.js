/**
 * Re-exports from @agent-dashboard/diff-panel.
 * Canonical source lives in packages/diff-panel/src/server/summarize-diff.js.
 */
export {
  summarizeDiff,
  truncateDiff,
  buildUserPrompt,
  MAX_DIFF_CHARS,
  DEFAULT_MODEL,
  SYSTEM_PROMPT,
} from "@agent-dashboard/diff-panel/server";
