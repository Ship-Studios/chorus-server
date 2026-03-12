/**
 * Eval suite for diff summary prompt quality.
 *
 * NOT part of the normal test suite — calls the real Anthropic API.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun run src/evals/diff-summary.eval.js
 *   ANTHROPIC_API_KEY=sk-... DIFF_SUMMARY_MODEL=claude-sonnet-4-5-20250514 bun run src/evals/diff-summary.eval.js
 *
 * Runs each fixture diff through the summarizeDiff() function (same prompt
 * and parameters as production) and evaluates the result against quality
 * criteria. Outputs a report with pass/fail per fixture and an overall score.
 *
 * Use this to iterate on the prompt in summarize-diff.js — change the prompt,
 * run the evals, compare scores.
 */

import { summarizeDiff, SYSTEM_PROMPT, DEFAULT_MODEL } from "@agent-dashboard/diff-panel/server";
import { fixtures } from "./fixtures.js";

// ── Quality checks ──────────────────────────────────────────────────────────

function countWords(text) {
  return text.split(/\s+/).filter(Boolean).length;
}

function hasBulletPoints(text) {
  // Matches lines starting with •, -, *, or numbered (1. 2.)
  return /^[\s]*[•\-\*\d\.]/m.test(text);
}

function containsAny(text, terms) {
  const lower = text.toLowerCase();
  return terms.some((term) => lower.includes(term.toLowerCase()));
}

function containsRawDiffSyntax(text) {
  // Check for raw diff artifacts that shouldn't be in a summary
  return /^[+-]{3}\s[ab]\//.test(text) || /^@@\s/.test(text) || /^diff --git/.test(text);
}

// ── Conversational tone checks ──────────────────────────────────────────────

// Transitional/connective phrases that indicate narrative flow
const CONNECTIVE_PHRASES = [
  "this change", "this update", "this commit", "this diff",
  "the main", "the key", "the most important",
  "additionally", "also", "along with", "as a result",
  "notably", "importantly", "in particular",
  "which means", "which allows", "which enables", "which ensures",
  "so that", "in order to", "to prevent", "to support", "to improve",
  "previously", "before this", "used to", "was vulnerable", "was hardcoded",
  "now", "instead", "rather than",
  "together", "overall", "in summary",
];

function hasConnectivePhrases(text) {
  const lower = text.toLowerCase();
  const found = CONNECTIVE_PHRASES.filter((p) => lower.includes(p));
  return { count: found.length, found };
}

function hasCompleteSentences(text) {
  // A complete sentence ends with . ! or ? and has at least 5 words before it
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const complete = sentences.filter((s) => countWords(s.trim()) >= 5);
  return { total: sentences.length, complete: complete.length };
}

function hasContextualReasoning(text) {
  // Checks for "why" language — explains impact, not just "what" changed
  const reasoningPatterns = [
    /which\s+(means|allows|enables|ensures|prevents|improves|reduces)/i,
    /so\s+that\b/i,
    /in\s+order\s+to\b/i,
    /to\s+(prevent|avoid|reduce|improve|enable|support|ensure)/i,
    /this\s+(means|allows|enables|ensures|prevents|improves|reduces)/i,
    /because\b/i,
    /since\b/i,
    /resulting\s+in\b/i,
    /impact|implication|consequence|trade-?off/i,
  ];
  const matched = reasoningPatterns.filter((p) => p.test(text));
  return { count: matched.length };
}

function runChecks(summary, expectations) {
  const checks = [];
  const wordCount = countWords(summary);

  // 1. Non-empty
  checks.push({
    name: "non-empty",
    pass: summary.trim().length > 0,
    detail: summary.trim().length > 0 ? `${summary.trim().length} chars` : "empty response",
  });

  // 2. Mentions relevant terms
  const hasRelevant = containsAny(summary, expectations.mentionsAny);
  checks.push({
    name: "mentions-relevant-terms",
    pass: hasRelevant,
    detail: hasRelevant
      ? `matched from [${expectations.mentionsAny.join(", ")}]`
      : `none of [${expectations.mentionsAny.join(", ")}] found`,
  });

  // 3. Under word limit (conversational prose gets a higher ceiling)
  const maxWords = expectations.maxWords ?? 200;
  checks.push({
    name: "under-word-limit",
    pass: wordCount <= maxWords,
    detail: `${wordCount} words (max ${maxWords})`,
  });

  // 4. No raw diff syntax
  const hasDiffSyntax = containsRawDiffSyntax(summary);
  checks.push({
    name: "no-raw-diff-syntax",
    pass: !hasDiffSyntax,
    detail: hasDiffSyntax ? "contains raw diff markers" : "clean prose",
  });

  // 5. No markdown headers (as instructed)
  const hasHeaders = /^#{1,4}\s/m.test(summary);
  checks.push({
    name: "no-markdown-headers",
    pass: !hasHeaders,
    detail: hasHeaders ? "contains markdown headers" : "no headers",
  });

  // 6. No bold text (as instructed — conversational, not formatted)
  const hasBold = /\*\*[^*]+\*\*/.test(summary);
  checks.push({
    name: "no-bold-text",
    pass: !hasBold,
    detail: hasBold ? "contains **bold** markers" : "no bold formatting",
  });

  // ── Conversational tone checks (applied to ALL fixtures) ─────────────────

  // 7. Uses connective/transitional phrases (natural language flow)
  const connectives = hasConnectivePhrases(summary);
  checks.push({
    name: "connective-phrases",
    pass: connectives.count >= 2,
    detail: `${connectives.count} phrases: [${connectives.found.slice(0, 4).join(", ")}${connectives.count > 4 ? "..." : ""}]`,
  });

  // 8. Contains complete sentences (reads like prose, not a list)
  const sentences = hasCompleteSentences(summary);
  checks.push({
    name: "complete-sentences",
    pass: sentences.complete >= 2,
    detail: `${sentences.complete}/${sentences.total} sentences with 5+ words`,
  });

  // 9. Explains "why" / impact, not just "what" changed
  const reasoning = hasContextualReasoning(summary);
  checks.push({
    name: "explains-why",
    pass: reasoning.count >= 1,
    detail: `${reasoning.count} reasoning pattern(s) found`,
  });

  // 10. Sufficient depth (conversational prose should not be too terse)
  checks.push({
    name: "sufficient-depth",
    pass: wordCount >= 40,
    detail: `${wordCount} words (min 40)`,
  });

  return checks;
}

// ── Reporter ────────────────────────────────────────────────────────────────

function formatCheck(check) {
  const icon = check.pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  return `    ${icon} ${check.name}: ${check.detail}`;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("\x1b[31mError: ANTHROPIC_API_KEY is required\x1b[0m");
    console.error("Usage: ANTHROPIC_API_KEY=sk-... bun run src/evals/diff-summary.eval.js");
    process.exit(1);
  }

  const model = process.env.DIFF_SUMMARY_MODEL ?? DEFAULT_MODEL;
  console.log("\n\x1b[1m╔══════════════════════════════════════════════════════╗\x1b[0m");
  console.log("\x1b[1m║        Diff Summary Prompt Eval Suite                ║\x1b[0m");
  console.log("\x1b[1m╚══════════════════════════════════════════════════════╝\x1b[0m");
  console.log(`\n  Model:  ${model}`);
  console.log(`  System: "${SYSTEM_PROMPT.slice(0, 60)}..."`);
  console.log(`  Fixtures: ${fixtures.length}\n`);

  const results = [];
  let totalChecks = 0;
  let totalPassed = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  for (let i = 0; i < fixtures.length; i++) {
    const fixture = fixtures[i];
    const label = `[${i + 1}/${fixtures.length}] ${fixture.name}`;

    console.log(`\x1b[1m${label}\x1b[0m`);
    console.log(`  stat: ${fixture.stat}`);

    const start = performance.now();
    let summary, usage;
    try {
      const result = await summarizeDiff({
        diff: fixture.diff,
        stat: fixture.stat,
        model,
      });
      summary = result.summary;
      usage = result.usage;
    } catch (err) {
      console.log(`  \x1b[31mERROR: ${err.message}\x1b[0m\n`);
      results.push({ fixture: fixture.name, error: err.message, checks: [], score: 0 });
      continue;
    }
    const elapsed = (performance.now() - start).toFixed(0);

    totalInputTokens += usage?.input_tokens ?? 0;
    totalOutputTokens += usage?.output_tokens ?? 0;

    // Display the summary
    console.log(`  \x1b[36mlatency: ${elapsed}ms | tokens: ${usage?.input_tokens ?? "?"}in/${usage?.output_tokens ?? "?"}out\x1b[0m`);
    console.log(`  \x1b[2m─── summary ───\x1b[0m`);
    for (const line of summary.split("\n")) {
      console.log(`  \x1b[33m${line}\x1b[0m`);
    }
    console.log(`  \x1b[2m───────────────\x1b[0m`);

    // Run quality checks
    const checks = runChecks(summary, fixture.expectations);
    const passed = checks.filter((c) => c.pass).length;
    const score = Math.round((passed / checks.length) * 100);
    totalChecks += checks.length;
    totalPassed += passed;

    for (const check of checks) {
      console.log(formatCheck(check));
    }

    console.log(`  Score: ${score}% (${passed}/${checks.length})\n`);

    results.push({
      fixture: fixture.name,
      nature: fixture.expectations.nature,
      summary,
      checks,
      score,
      latencyMs: parseInt(elapsed),
      tokens: usage,
    });
  }

  // ── Summary report ──────────────────────────────────────────────────────
  const overallScore = Math.round((totalPassed / totalChecks) * 100);
  const allPerfect = results.every((r) => r.score === 100);
  const failures = results.filter((r) => r.score < 100 || r.error);

  console.log("\x1b[1m══════════════════════════════════════════════════════\x1b[0m");
  console.log("\x1b[1m  RESULTS\x1b[0m\n");

  for (const r of results) {
    const icon = r.error ? "\x1b[31m✗\x1b[0m" : r.score === 100 ? "\x1b[32m✓\x1b[0m" : "\x1b[33m~\x1b[0m";
    const scoreStr = r.error ? "ERROR" : `${r.score}%`;
    const latency = r.latencyMs ? `${r.latencyMs}ms` : "—";
    console.log(`  ${icon} ${r.fixture}  ${scoreStr}  ${latency}`);
  }

  console.log(`\n  Overall: \x1b[${overallScore >= 80 ? "32" : overallScore >= 60 ? "33" : "31"}m${overallScore}%\x1b[0m (${totalPassed}/${totalChecks} checks)`);
  console.log(`  Tokens:  ${totalInputTokens} in / ${totalOutputTokens} out`);

  if (failures.length > 0) {
    console.log(`\n  \x1b[33mFailed checks:\x1b[0m`);
    for (const r of failures) {
      if (r.error) {
        console.log(`    ${r.fixture}: ${r.error}`);
      } else {
        const failed = r.checks.filter((c) => !c.pass);
        for (const c of failed) {
          console.log(`    ${r.fixture} → ${c.name}: ${c.detail}`);
        }
      }
    }
  }

  console.log("\n\x1b[1m══════════════════════════════════════════════════════\x1b[0m\n");

  // Exit with non-zero if below threshold
  if (overallScore < 70) {
    console.log("\x1b[31mFailed: overall score below 70% threshold\x1b[0m");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
