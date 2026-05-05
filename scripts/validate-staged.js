#!/usr/bin/env node
/**
 * validate-staged.js
 *
 * Entry point for the pre-commit hook.
 * Reviews only the files staged for this commit.
 *
 * Flow:
 *   git diff --cached  →  parseDiff  →  cache check  →  AI review  →  output
 *
 * Exit codes:
 *   0 — PASS or WARNING only (commit proceeds)
 *   1 — BLOCKING error found (commit is aborted)
 */

import { getStagedDiff, parseDiff } from './diff-utils.js';
import { reviewFiles }               from './ai-review.js';
import { printResults, printSummary, hasBlockingErrors, printVerdict } from './output-utils.js';

const VERBOSE = process.env.AI_REVIEW_VERBOSE === '1' || process.argv.includes('--verbose');

async function main() {
  process.stdout.write('\n🔍  AI Code Review — Staged Changes\n');

  const rawDiff = getStagedDiff();

  if (!rawDiff.trim()) {
    process.stdout.write('✔   No staged changes — nothing to review.\n\n');
    process.exit(0);
  }

  const fileChunks = parseDiff(rawDiff);

  if (fileChunks.length === 0) {
    process.stdout.write('✔   Staged changes contain no reviewable source files.\n\n');
    process.exit(0);
  }

  process.stdout.write(`\n    Staged files to review: ${fileChunks.length}\n`);
  if (VERBOSE) {
    for (const c of fileChunks) {
      process.stdout.write(`      • ${c.filePath} (${c.changedLines} added lines)\n`);
    }
  }
  process.stdout.write('\n');

  const results = await reviewFiles(fileChunks, { verbose: true });

  printResults(results);
  printSummary(results, 'staged');

  const blocked = hasBlockingErrors(results);
  printVerdict(blocked, 'staged');

  process.exit(blocked ? 1 : 0);
}

main().catch(err => {
  process.stderr.write(`[validate-staged] Unexpected error: ${err.message}\n`);
  // On unexpected error don't block the commit — fail open, warn loudly
  process.exit(0);
});
