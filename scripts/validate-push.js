#!/usr/bin/env node
/**
 * validate-push.js
 *
 * Entry point for the pre-push hook.
 * Reviews all commits that are about to be pushed but aren't on origin yet.
 *
 * Flow:
 *   git diff origin/main...HEAD  →  parseDiff  →  cache check  →  AI review  →  output
 *
 * Exit codes:
 *   0 — PASS or WARNING only (push proceeds)
 *   1 — BLOCKING error found (push is aborted)
 */

import { getPushDiff, parseDiff } from './diff-utils.js';
import { reviewFiles }             from './ai-review.js';
import { printResults, printSummary, hasBlockingErrors, printVerdict } from './output-utils.js';

const VERBOSE = process.env.AI_REVIEW_VERBOSE === '1' || process.argv.includes('--verbose');


async function main() {
  process.stdout.write('\n🚀  AI Code Review — Push Changes\n');

  const base    = process.env.AI_REVIEW_BASE || 'origin/main';
  const rawDiff = getPushDiff(base);

  if (!rawDiff.trim()) {
    process.stdout.write('✔   No new commits to push — nothing to review.\n\n');
    process.exit(0);
  }

  const fileChunks = parseDiff(rawDiff);

  if (fileChunks.length === 0) {
    process.stdout.write('✔   Push diff contains no reviewable source files.\n\n');
    process.exit(0);
  }

  process.stdout.write(`\n    Files changed vs ${base}: ${fileChunks.length}\n`);
  if (VERBOSE) {
    for (const c of fileChunks) {
      process.stdout.write(`      • ${c.filePath} (${c.changedLines} added lines)\n`);
    }
  }
  process.stdout.write('\n');

  // Pre-push review is deeper: pass verbose:true always so the developer
  // sees what's being reviewed before the push goes through.
  const results = await reviewFiles(fileChunks, { verbose: true, mode: 'push' });

  printResults(results);
  printSummary(results, 'push');

  const blocked = hasBlockingErrors(results);
  printVerdict(blocked, 'push');

  process.exit(blocked ? 1 : 0);
}

main().catch(err => {
  process.stderr.write(`[validate-push] Unexpected error: ${err.message}\n`);
  // Don't block the push on an unexpected error — fail open
  process.exit(0);
});
