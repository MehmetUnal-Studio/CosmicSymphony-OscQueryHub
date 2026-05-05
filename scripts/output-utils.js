/**
 * output-utils.js
 *
 * Terminal output formatting for AI review results.
 * Uses ANSI color codes — no dependencies.
 */

// ── ANSI ──────────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  white:  '\x1b[37m',
  gray:   '\x1b[90m',
  bgRed:  '\x1b[41m',
  bgYellow: '\x1b[43m',
  bgGreen:  '\x1b[42m',
};

const dim   = s => `${C.dim}${s}${C.reset}`;
const bold  = s => `${C.bold}${s}${C.reset}`;
const green = s => `${C.green}${s}${C.reset}`;
const yellow= s => `${C.yellow}${s}${C.reset}`;
const red   = s => `${C.red}${s}${C.reset}`;
const cyan  = s => `${C.cyan}${s}${C.reset}`;
const gray  = s => `${C.gray}${s}${C.reset}`;

// ── STATUS BADGES ─────────────────────────────────────────────────────────────

function badge(status) {
  switch (status) {
    case 'PASS':     return `${C.bgGreen}${C.bold}  PASS  ${C.reset}`;
    case 'WARNING':  return `${C.bgYellow}${C.bold} WARNING${C.reset}`;
    case 'BLOCKING': return `${C.bgRed}${C.bold}  BLOCK ${C.reset}`;
    default:         return `${C.dim} ${status} ${C.reset}`;
  }
}

function severityIcon(severity) {
  return severity === 'blocking' ? red('✖') : yellow('⚠');
}

// ── MAIN PRINT FUNCTION ───────────────────────────────────────────────────────

/**
 * Prints a formatted summary of all review results to stdout.
 *
 * @param {Array<FileReviewResult>} results - From reviewFiles()
 */
export function printResults(results) {
  const line = gray('─'.repeat(60));

  for (const { filePath, result, cached, skipped } of results) {
    const status = result.status || 'PASS';
    const suffix = cached  ? dim(' [cached]')
                 : skipped ? dim(' [skipped]')
                 : '';

    process.stdout.write(`\n${badge(status)} ${bold(filePath)}${suffix}\n`);

    if (result.summary && status !== 'PASS') {
      process.stdout.write(`  ${gray('↳')} ${result.summary}\n`);
    }

    if (result.issues && result.issues.length > 0) {
      process.stdout.write(`${line}\n`);

      for (const issue of result.issues) {
        const icon = severityIcon(issue.severity);
        const loc  = issue.line ? cyan(`line ${issue.line}`) : '';
        const header = [icon, bold(issue.message), loc].filter(Boolean).join('  ');

        process.stdout.write(`  ${header}\n`);

        if (issue.code) {
          // Indent the code snippet
          const snippet = issue.code.split('\n')
            .map(l => `    ${gray('│')} ${l}`)
            .join('\n');
          process.stdout.write(`${snippet}\n`);
        }

        if (issue.fix) {
          process.stdout.write(`  ${green('→')} ${issue.fix}\n`);
        }

        process.stdout.write('\n');
      }
    }
  }
}

/**
 * Prints a compact summary table after all files are reviewed.
 *
 * @param {Array<FileReviewResult>} results
 * @param {string} mode - 'staged' | 'push'
 */
export function printSummary(results, mode = 'staged') {
  const line = gray('─'.repeat(60));
  const total     = results.length;
  const passed    = results.filter(r => r.result.status === 'PASS').length;
  const warnings  = results.filter(r => r.result.status === 'WARNING').length;
  const blocking  = results.filter(r => r.result.status === 'BLOCKING').length;
  const cached    = results.filter(r => r.cached).length;

  process.stdout.write(`\n${line}\n`);
  process.stdout.write(`${bold('Summary')} — ${mode === 'push' ? 'pre-push' : 'pre-commit'} review\n`);
  process.stdout.write(`  Files reviewed:  ${total}\n`);
  process.stdout.write(`  ${green('✔')} Passed:   ${passed}\n`);
  if (warnings > 0)  process.stdout.write(`  ${yellow('⚠')} Warnings: ${warnings}\n`);
  if (blocking > 0)  process.stdout.write(`  ${red('✖')} Blocking: ${blocking}\n`);
  if (cached > 0)    process.stdout.write(`  ${gray('↩')} Cached:   ${cached}\n`);
  process.stdout.write(`${line}\n`);
}

/**
 * Returns true if any result has status BLOCKING.
 * @param {Array<FileReviewResult>} results
 * @returns {boolean}
 */
export function hasBlockingErrors(results) {
  return results.some(r => r.result.status === 'BLOCKING');
}

/**
 * Prints the final verdict line with exit instruction.
 * @param {boolean} blocked
 * @param {string}  mode
 */
export function printVerdict(blocked, mode = 'staged') {
  const action = mode === 'push' ? 'Push' : 'Commit';
  if (blocked) {
    process.stdout.write(
      `\n${red(`✖ ${action} blocked.`)} Fix the BLOCKING issues above and try again.\n\n`
    );
  } else {
    process.stdout.write(`\n${green(`✔ ${action} approved.`)}\n\n`);
  }
}
