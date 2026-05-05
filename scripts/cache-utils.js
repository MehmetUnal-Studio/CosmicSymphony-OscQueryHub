/**
 * cache-utils.js
 *
 * Hash-based result cache for AI reviews.
 * Key = SHA-256(fileDiff + rulesHash)
 * If the same diff chunk is seen again (same hash), the AI call is skipped.
 *
 * Cache file: .ai-review-cache.json (project root)
 * TTL: 7 days (configurable via CACHE_TTL_HOURS env var)
 */

import fs from 'fs';
import crypto from 'crypto';
import path from 'path';

const CACHE_FILE = path.resolve(process.cwd(), '.ai-review-cache.json');
const CACHE_TTL_MS = (parseInt(process.env.CACHE_TTL_HOURS || '168', 10)) * 60 * 60 * 1000;

// ── LOAD / SAVE ───────────────────────────────────────────────────────────────

/**
 * Loads the cache from disk. Returns an empty object on any error.
 * @returns {Record<string, CacheEntry>}
 */
export function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return {};
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Writes the cache back to disk. Non-fatal if it fails.
 * @param {Record<string, CacheEntry>} cache
 */
export function saveCache(cache) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    // Don't block the commit/push just because cache write failed
    process.stderr.write(`[cache] Write failed: ${err.message}\n`);
  }
}

// ── KEY GENERATION ────────────────────────────────────────────────────────────

/**
 * Generates a cache key from a file's raw diff + the current rules hash.
 * If either changes, the entry will be treated as a miss.
 *
 * @param {string} diffContent - The raw diff string for one file
 * @param {string} rulesHash   - Short hash of .ai-rules.json content
 * @returns {string} 16-char hex key
 */
export function getCacheKey(diffContent, rulesHash) {
  return crypto
    .createHash('sha256')
    .update(diffContent + '::' + rulesHash)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Returns a short hash of the rules file content.
 * Used to invalidate cached results whenever rules change.
 *
 * @param {string|object} rulesContent
 * @returns {string} 8-char hex hash
 */
export function hashRules(rulesContent) {
  const str = typeof rulesContent === 'string'
    ? rulesContent
    : JSON.stringify(rulesContent);
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 8);
}

// ── GET / SET ─────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CacheEntry
 * @property {ReviewResult} result
 * @property {number}       timestamp - Unix ms when this was cached
 * @property {string}       model     - Model used for this review
 */

/**
 * @typedef {Object} ReviewResult
 * @property {'PASS'|'WARNING'|'BLOCKING'} status
 * @property {string}   summary
 * @property {Issue[]}  issues
 */

/**
 * Returns the cached ReviewResult for the given key, or null if absent/expired.
 *
 * @param {Record<string, CacheEntry>} cache
 * @param {string} key
 * @returns {ReviewResult|null}
 */
export function getCachedResult(cache, key) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
  return entry.result;
}

/**
 * Stores a ReviewResult in the cache under the given key.
 *
 * @param {Record<string, CacheEntry>} cache
 * @param {string}       key
 * @param {ReviewResult} result
 * @param {string}       model
 */
export function setCachedResult(cache, key, result, model) {
  cache[key] = {
    result,
    timestamp: Date.now(),
    model,
  };
}

// ── MAINTENANCE ───────────────────────────────────────────────────────────────

/**
 * Removes expired entries from the cache in-place.
 * Call this occasionally to keep the cache file small.
 *
 * @param {Record<string, CacheEntry>} cache
 * @returns {number} Number of entries removed
 */
export function cleanExpiredCache(cache) {
  const now = Date.now();
  let removed = 0;
  for (const key of Object.keys(cache)) {
    if (now - cache[key].timestamp > CACHE_TTL_MS) {
      delete cache[key];
      removed++;
    }
  }
  return removed;
}

/**
 * Returns cache statistics for display.
 * @param {Record<string, CacheEntry>} cache
 */
export function getCacheStats(cache) {
  const entries = Object.values(cache);
  const now = Date.now();
  const valid = entries.filter(e => now - e.timestamp <= CACHE_TTL_MS);
  const byStatus = valid.reduce((acc, e) => {
    const s = e.result?.status || 'UNKNOWN';
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});
  return { total: entries.length, valid: valid.length, byStatus };
}
