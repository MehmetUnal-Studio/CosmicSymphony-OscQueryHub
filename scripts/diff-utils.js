/**
 * diff-utils.js
 *
 * Parses git diff output into structured chunks.
 * Only sends changed hunks to the AI — never full files.
 */

import { execSync } from 'child_process';
import crypto from 'crypto';
import path from 'path';

// ── IGNORE LISTS ─────────────────────────────────────────────────────────────

const IGNORED_EXTENSIONS = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp', '.tiff',
  // Audio / Video
  '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.aac', '.mov', '.avi', '.mkv',
  // Archives
  '.zip', '.tar', '.gz', '.bz2', '.rar', '.7z',
  // Documents / Office
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  // Fonts
  '.ttf', '.woff', '.woff2', '.eot', '.otf',
  // Binaries / compiled
  '.bin', '.exe', '.dll', '.so', '.dylib', '.class', '.pyc',
  // Lock files / generated
  '.lock',
  // Max for Live / Max/MSP
  '.amxd', '.maxpat',
]);

const IGNORED_DIR_SEGMENTS = new Set([
  'node_modules', 'dist', 'build', '.next', '.nuxt',
  'coverage', '.git', 'vendor', '__pycache__', '.cache',
  'out', '.turbo', '.vercel',
]);

// ── FILE FILTERS ─────────────────────────────────────────────────────────────

/**
 * Returns true if the file should be skipped entirely.
 * @param {string} filePath
 */
export function shouldIgnoreFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IGNORED_EXTENSIONS.has(ext)) return true;

  const segments = filePath.split('/');
  return segments.some(seg => IGNORED_DIR_SEGMENTS.has(seg));
}

// ── GIT DIFF COMMANDS ─────────────────────────────────────────────────────────

/**
 * Returns the raw diff of files staged for commit.
 * Used by validate-staged.js (pre-commit).
 */
export function getStagedDiff() {
  try {
    return execSync('git diff --cached --diff-filter=ACMR', { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

/**
 * Returns the names of staged files only (no diff body).
 */
export function getStagedFiles() {
  try {
    return execSync('git diff --cached --name-only --diff-filter=ACMR', { encoding: 'utf-8' })
      .trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Returns the raw diff of commits not yet pushed.
 * Used by validate-push.js (pre-push).
 * Falls back gracefully when origin/main doesn't exist.
 *
 * @param {string} base - Base branch/ref to compare against
 */
export function getPushDiff(base = 'origin/main') {
  // Try the standard three-dot range first
  const attempts = [
    () => execSync(`git diff ${base}...HEAD --diff-filter=ACMR`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }),
    () => execSync(`git diff ${base}..HEAD --diff-filter=ACMR`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }),
    () => {
      const root = execSync('git rev-list --max-parents=0 HEAD', { encoding: 'utf-8' }).trim();
      return execSync(`git diff ${root}..HEAD --diff-filter=ACMR`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    },
  ];

  for (const attempt of attempts) {
    try { return attempt(); } catch { /* try next */ }
  }
  return '';
}

// ── DIFF PARSER ───────────────────────────────────────────────────────────────

/**
 * Parses raw git diff output into an array of per-file diff objects.
 *
 * @param {string} rawDiff
 * @returns {Array<FileChunk>}
 *
 * @typedef {Object} FileChunk
 * @property {string}   filePath     - Relative path to the file
 * @property {Hunk[]}   hunks        - Parsed change hunks
 * @property {string}   fullDiff     - Raw diff text for this file (used for hashing)
 * @property {string}   diffHash     - SHA-256 of fullDiff (used for cache key)
 * @property {number}   changedLines - Total number of added lines
 */
export function parseDiff(rawDiff) {
  if (!rawDiff || !rawDiff.trim()) return [];

  const results = [];
  // Each file section starts with "diff --git"
  const fileSections = rawDiff.split(/^(?=diff --git )/m).filter(Boolean);

  for (const section of fileSections) {
    const lines = section.split('\n');
    const headerLine = lines[0]; // e.g. "diff --git a/src/foo.ts b/src/foo.ts"

    const headerMatch = headerLine.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!headerMatch) continue;

    const filePath = headerMatch[2]; // 'b/' path = new file name

    // Skip ignored files
    if (shouldIgnoreFile(filePath)) continue;

    // Skip binary diffs
    if (section.includes('Binary files') || section.includes('GIT binary patch')) continue;

    // Skip files with no hunk headers (e.g. pure metadata changes)
    if (!section.includes('\n@@')) continue;

    const hunks = parseHunks(lines);
    if (hunks.length === 0) continue;

    const diffHash = crypto.createHash('sha256').update(section).digest('hex');

    results.push({
      filePath,
      hunks,
      fullDiff: section,
      diffHash,
      changedLines: hunks.reduce((n, h) => n + h.addedLines.length, 0),
    });
  }

  return results;
}

// ── HUNK PARSER ───────────────────────────────────────────────────────────────

/**
 * Parses the hunk sections within one file's diff lines.
 *
 * @typedef {Object} Hunk
 * @property {number}   oldStart
 * @property {number}   newStart
 * @property {string}   functionContext - text after @@ header (e.g. function name)
 * @property {string[]} lines           - all lines in hunk (+/-/context)
 * @property {string[]} addedLines      - only added lines (without leading +)
 * @property {string[]} removedLines    - only removed lines (without leading -)
 */
function parseHunks(lines) {
  const hunks = [];
  let current = null;

  for (const line of lines) {
    const hunkHeader = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
    if (hunkHeader) {
      if (current) hunks.push(current);
      current = {
        oldStart: parseInt(hunkHeader[1], 10),
        newStart: parseInt(hunkHeader[2], 10),
        functionContext: hunkHeader[3].trim(),
        lines: [],
        addedLines: [],
        removedLines: [],
      };
      continue;
    }

    if (!current) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      current.lines.push(line);
      current.addedLines.push(line.slice(1));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      current.lines.push(line);
      current.removedLines.push(line.slice(1));
    } else if (line.startsWith(' ')) {
      current.lines.push(line); // context
    }
  }

  if (current) hunks.push(current);
  return hunks;
}

// ── REVIEW FORMATTER ─────────────────────────────────────────────────────────

/**
 * Formats a FileChunk into a compact text block for the AI.
 * Sends only hunks, not the full file — keeps token count low.
 *
 * @param {FileChunk} chunk
 * @returns {string}
 */
export function formatDiffForReview(chunk) {
  const hunkTexts = chunk.hunks.map(h => {
    const header = `@@ line ~${h.newStart}${h.functionContext ? ' ' + h.functionContext : ''} @@`;
    return `${header}\n${h.lines.join('\n')}`;
  });

  return `File: ${chunk.filePath}\n\`\`\`diff\n${hunkTexts.join('\n\n')}\n\`\`\``;
}

/**
 * Rough token estimate (1 token ≈ 4 characters).
 * Useful for logging and deciding whether to batch hunks.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}
