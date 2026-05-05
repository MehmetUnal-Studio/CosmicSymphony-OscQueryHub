/**
 * ai-review.js
 *
 * Core AI review engine using the Anthropic Claude API.
 *
 * Token optimization strategy:
 * - Sends git diff hunks only — never full files
 * - System prompt (rules) is sent with cache_control: ephemeral
 *   so Anthropic caches it across calls in the same session
 * - Per-file results are cached locally by diff hash + rules hash
 * - Skips files whose hash already exists in .ai-review-cache.json
 */

import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import path from 'path';

import { formatDiffForReview, estimateTokens } from './diff-utils.js';
import {
  loadCache, saveCache,
  getCacheKey, getCachedResult, setCachedResult,
  hashRules, cleanExpiredCache,
} from './cache-utils.js';

const RULES_FILE  = path.resolve(process.cwd(), '.ai-rules.json');
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001'; // fastest + cheapest for validation
const MAX_TOKENS    = 1024;

// ── RULES ─────────────────────────────────────────────────────────────────────

/**
 * Loads and parses .ai-rules.json.
 * Falls back to minimal defaults if the file is missing.
 */
export function loadRules() {
  try {
    return JSON.parse(fs.readFileSync(RULES_FILE, 'utf-8'));
  } catch (err) {
    process.stderr.write(`[ai-review] .ai-rules.json not found (${err.message}) — using defaults\n`);
    return { rules: {}, ignorePatterns: [], model: DEFAULT_MODEL };
  }
}

// ── SYSTEM PROMPT ─────────────────────────────────────────────────────────────

/**
 * Builds the system prompt from the loaded rules.
 * This text is sent with Anthropic prompt caching — it won't be re-tokenized
 * on subsequent calls within the same session as long as it's unchanged.
 *
 * @param {object} rules - Parsed .ai-rules.json
 * @returns {string}
 */
function buildSystemPrompt(rules) {
  // Omit fields that shouldn't influence code review wording
  const { model: _m, ignorePatterns: _i, ...reviewRules } = rules;

  return `You are a senior software engineer performing automated code review in a CI/CD pipeline.
You receive git diff hunks — ONLY the lines that changed.

## Project Rules
${JSON.stringify(reviewRules, null, 2)}

## What to check (added lines only — ignore removed lines)
- Security vulnerabilities (XSS, injection, hardcoded secrets, open redirects)
- Broken or missing imports
- Inconsistent naming (violates project conventions in rules above)
- Risky architectural changes (e.g. removing auth checks, changing public APIs)
- Duplicated logic that already exists elsewhere
- Compatibility issues (Node.js version, browser support)
- Obvious performance problems (blocking I/O in hot paths, N+1 queries)
- Violations of the rules listed above

## Severity
- BLOCKING: must fix before commit/push (security, broken build, forbidden patterns)
- WARNING:  should fix soon (style, naming, performance)
- PASS:     no issues

## Response format — ONLY valid JSON, no extra text
{
  "status": "PASS" | "WARNING" | "BLOCKING",
  "summary": "<one-sentence summary>",
  "issues": [
    {
      "severity": "blocking" | "warning",
      "file": "<relative path>",
      "line": <approximate line number or 0 if unknown>,
      "code": "<the problematic snippet>",
      "message": "<what is wrong and why>",
      "fix": "<concrete suggestion>"
    }
  ]
}

If there are no issues: { "status": "PASS", "summary": "No issues found.", "issues": [] }`;
}

// ── SINGLE FILE REVIEW ────────────────────────────────────────────────────────

/**
 * Sends one file's diff to Claude and returns a structured ReviewResult.
 * The system prompt is marked with cache_control so Anthropic can cache it
 * server-side — subsequent calls with the same prompt text are cheaper & faster.
 *
 * @param {Anthropic}  client
 * @param {FileChunk}  chunk
 * @param {string}     systemPrompt
 * @param {string}     model
 * @returns {Promise<ReviewResult>}
 */
async function reviewSingleFile(client, chunk, systemPrompt, model) {
  const diffText = formatDiffForReview(chunk);

  const response = await client.messages.create({
    model,
    max_tokens: MAX_TOKENS,
    system: [
      {
        type: 'text',
        text: systemPrompt,
        // Anthropic caches this across requests — avoids re-tokenizing rules every time
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Review the following diff. Respond with JSON only, no markdown fences:\n\n${diffText}`,
      },
    ],
  });

  const raw = (response.content[0]?.text || '').trim();

  // Strip accidental markdown fences if model wraps JSON in ```json ... ```
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    // Unparseable response → treat as a soft warning, don't block
    return {
      status: 'WARNING',
      summary: 'AI response could not be parsed — manual review recommended.',
      issues: [],
    };
  }
}

// ── BATCH REVIEW ──────────────────────────────────────────────────────────────

/**
 * Reviews an array of FileChunks.
 * - Checks local cache first (skips API call if hash matches)
 * - Cleans expired cache entries on each run
 * - Saves updated cache to disk after all reviews complete
 *
 * @param {FileChunk[]} fileChunks - From parseDiff()
 * @param {object}      options
 * @param {boolean}     [options.verbose=false] - Print per-file progress
 * @returns {Promise<Array<FileReviewResult>>}
 *
 * @typedef {Object} FileReviewResult
 * @property {string}       filePath
 * @property {ReviewResult} result
 * @property {boolean}      cached   - true if result came from cache
 */
export async function reviewFiles(fileChunks, options = {}) {
  const { verbose = false } = options;

  // No API key → skip AI review gracefully (lint-staged still runs)
  if (!process.env.ANTHROPIC_API_KEY) {
    if (verbose) {
      process.stdout.write('  [ai-review] ANTHROPIC_API_KEY not set — AI review skipped\n');
    }
    return fileChunks.map(chunk => ({
      filePath: chunk.filePath,
      result: { status: 'PASS', summary: 'AI review skipped (no API key).', issues: [] },
      cached: false,
      skipped: true,
    }));
  }

  const rules       = loadRules();
  const model       = rules.model || DEFAULT_MODEL;
  const rulesHash   = hashRules(rules);
  const systemPrompt = buildSystemPrompt(rules);
  const client      = new Anthropic();
  const cache       = loadCache();

  // Clean old entries on every run (keeps cache file small)
  const expired = cleanExpiredCache(cache);
  if (expired > 0 && verbose) {
    process.stdout.write(`  [cache] Removed ${expired} expired entries\n`);
  }

  let cacheHits = 0;
  let apiCalls  = 0;
  const results = [];

  for (const chunk of fileChunks) {
    const cacheKey = getCacheKey(chunk.fullDiff, rulesHash);
    const cached   = getCachedResult(cache, cacheKey);

    if (cached) {
      cacheHits++;
      if (verbose) process.stdout.write(`  ↩  [cached]   ${chunk.filePath}\n`);
      results.push({ filePath: chunk.filePath, result: cached, cached: true });
      continue;
    }

    const tokens = estimateTokens(chunk.fullDiff);
    if (verbose) {
      process.stdout.write(`  ✦  [reviewing] ${chunk.filePath} (~${tokens} diff tokens)\n`);
    }

    try {
      const result = await reviewSingleFile(client, chunk, systemPrompt, model);
      setCachedResult(cache, cacheKey, result, model);
      apiCalls++;
      results.push({ filePath: chunk.filePath, result, cached: false });
    } catch (err) {
      // API failure is non-fatal — warn but don't block the commit
      process.stderr.write(`  [ai-review] Failed to review ${chunk.filePath}: ${err.message}\n`);
      results.push({
        filePath: chunk.filePath,
        result: {
          status: 'WARNING',
          summary: `Review failed: ${err.message}`,
          issues: [],
        },
        cached: false,
        error: true,
      });
    }
  }

  saveCache(cache);

  if (verbose) {
    process.stdout.write(
      `  [ai-review] Done — ${apiCalls} API call(s), ${cacheHits} cache hit(s)\n`
    );
  }

  return results;
}
