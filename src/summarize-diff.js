/**
 * Core diff summarization logic.
 *
 * Extracted from the route handler so the same prompt and parameters
 * are shared between production code and the eval suite.
 * When iterating on the prompt, change it here — both the API endpoint
 * and the evals will pick up the change automatically.
 */

import Anthropic from "@anthropic-ai/sdk";

export const MAX_DIFF_CHARS = 30_000;
export const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

export const SYSTEM_PROMPT =
  "You summarize git diffs in a conversational tone for developers viewing a dashboard. " +
  "Write like a teammate explaining what happened in this change — be specific and natural. " +
  "Use 1-3 short paragraphs. Each paragraph should explain what changed AND why it matters. " +
  "Connect your points with context: mention what the code did previously, what it does now, and the practical impact. " +
  "No markdown headers, no bold text, no bullet points. Keep it under 150 words.";

export function buildUserPrompt(stat, diff) {
  return (
    "Summarize this git diff conversationally in 1-3 short paragraphs. " +
    "For each key change, explain what the code previously did versus what it does now, and why it matters. " +
    "Focus on functional impact, not line-by-line details. " +
    "Group related changes together.\n\n" +
    `<stat>\n${stat}\n</stat>\n\n` +
    `<diff>\n${diff}\n</diff>`
  );
}

export function truncateDiff(diff) {
  if (diff.length > MAX_DIFF_CHARS) {
    return diff.slice(0, MAX_DIFF_CHARS) + "\n\n[diff truncated]";
  }
  return diff;
}

/**
 * Summarize a git diff using Claude.
 *
 * @param {object} opts
 * @param {string} opts.diff   - Raw unified diff text
 * @param {string} opts.stat   - Git stat summary (e.g. "3 files changed, 45 insertions(+), 12 deletions(-)")
 * @param {string} [opts.model] - Model override (defaults to DIFF_SUMMARY_MODEL env or DEFAULT_MODEL)
 * @param {Anthropic} [opts.client] - Anthropic client instance (created from env if omitted)
 * @returns {Promise<{ summary: string, model: string, usage: { input_tokens: number, output_tokens: number } }>}
 */
export async function summarizeDiff({ diff, stat, model, client }) {
  const anthropic = client ?? new Anthropic();
  const resolvedModel = model ?? process.env.DIFF_SUMMARY_MODEL ?? DEFAULT_MODEL;
  const truncatedDiff = truncateDiff(diff);

  const msg = await anthropic.messages.create({
    model: resolvedModel,
    max_tokens: 512,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: buildUserPrompt(stat, truncatedDiff),
      },
    ],
  });

  return {
    summary: msg.content[0]?.text ?? "",
    model: resolvedModel,
    usage: msg.usage,
  };
}
