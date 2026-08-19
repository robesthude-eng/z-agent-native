import fs from 'node:fs';
import path from 'node:path';

const MAX_FAILURES_REPORTED = 40;
const TAIL_LINES = 120;

/**
 * Planning and parsing only. Execution deliberately stays in tools.mjs so the
 * sandbox identity, timeout and kill-group handling live in exactly one place,
 * and so every parser below stays unit-testable without spawning a shell.
 */

export function detectTestCommand(root) {
  const packageFile = path.join(root, 'package.json');
  if (fs.existsSync(packageFile)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
      const scripts = manifest?.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
      if (typeof scripts.test === 'string' && scripts.test.trim()) {
        return { command: 'npm test', framework: guessFramework(scripts.test), source: 'package.json scripts.test' };
      }
    } catch { /* an unreadable manifest is a detection miss, not a failure */ }
  }
  if (fs.existsSync(path.join(root, 'pytest.ini')) || fs.existsSync(path.join(root, 'pyproject.toml'))) {
    return { command: 'pytest -q', framework: 'pytest', source: 'python project' };
  }
  if (fs.existsSync(path.join(root, 'go.mod'))) {
    return { command: 'go test ./...', framework: 'go', source: 'go module' };
  }
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) {
    return { command: 'cargo test', framework: 'cargo', source: 'cargo manifest' };
  }
  if (fs.existsSync(path.join(root, 'gradlew'))) {
    return { command: './gradlew test', framework: 'gradle', source: 'gradle wrapper' };
  }
  return null;
}

export function guessFramework(command) {
  const value = String(command || '').toLowerCase();
  if (value.includes('vitest')) return 'vitest';
  if (value.includes('jest')) return 'jest';
  if (value.includes('node --test') || value.includes('node:test')) return 'node';
  if (value.includes('pytest')) return 'pytest';
  if (value.includes('go test')) return 'go';
  if (value.includes('cargo test')) return 'cargo';
  if (value.includes('gradle')) return 'gradle';
  return 'unknown';
}

export function buildTestCommand(root, input = {}) {
  const explicit = String(input.command || '').trim();
  // An explicit command must still honour filter; silently dropping it would
  // run the whole suite while the caller believes it ran one test.
  const base = explicit
    ? { command: explicit, framework: guessFramework(explicit), source: 'explicit command' }
    : detectTestCommand(root);
  if (!base) {
    throw new Error('No test command could be detected. Pass command explicitly, for example command="npm test" or command="pytest -q".');
  }
  const filter = String(input.filter || '').trim();
  if (!filter) return base;
  // Filters are appended as a separate argument rather than interpolated into
  // the middle of a script, so a filter can never rewrite the base command.
  const separator = base.command.startsWith('npm ') ? ' -- ' : ' ';
  return { ...base, command: `${base.command}${separator}${filter}`, source: `${base.source} + filter` };
}

function addFailure(failures, seen, name, file) {
  const label = String(name || '').trim();
  if (!label) return;
  const key = `${file || ''}::${label}`;
  if (seen.has(key)) return;
  seen.add(key);
  failures.push(file ? { name: label, file } : { name: label });
}

export function parseTestOutput(text) {
  const body = String(text || '');
  const failures = [];
  const seen = new Set();

  // node:test and any other TAP producer
  for (const match of body.matchAll(/^not ok \d+ - (.+)$/gm)) addFailure(failures, seen, match[1]);
  // vitest / jest per-test markers
  for (const match of body.matchAll(/^\s*[x\u00d7\u2715\u2717]\s+(.+?)(?:\s+\d+\s*ms)?\s*$/gm)) addFailure(failures, seen, match[1]);
  // vitest / jest file-level failures
  for (const match of body.matchAll(/^\s*FAIL\s+(\S+)\s*(.*)$/gm)) {
    addFailure(failures, seen, match[2].trim() || match[1], match[1]);
  }
  // pytest
  for (const match of body.matchAll(/^FAILED\s+([^\s:]+)(?:::(\S+))?/gm)) addFailure(failures, seen, match[2] || match[1], match[1]);
  // go test
  for (const match of body.matchAll(/^\s*--- FAIL: (\S+)/gm)) addFailure(failures, seen, match[1]);

  const totals = {};
  const tapPass = body.match(/^# pass (\d+)/m);
  const tapFail = body.match(/^# fail (\d+)/m);
  const tapSkip = body.match(/^# skipped (\d+)/m);
  if (tapPass) totals.passed = Number(tapPass[1]);
  if (tapFail) totals.failed = Number(tapFail[1]);
  if (tapSkip) totals.skipped = Number(tapSkip[1]);

  const vitest = body.match(/Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed(?:\s*\|\s*(\d+) skipped)?/);
  if (vitest) {
    if (vitest[1]) totals.failed = Number(vitest[1]);
    totals.passed = Number(vitest[2]);
    if (vitest[3]) totals.skipped = Number(vitest[3]);
  }

  const pytest = body.match(/(\d+) failed,\s*(\d+) passed/);
  if (pytest) {
    totals.failed = Number(pytest[1]);
    totals.passed = Number(pytest[2]);
  }

  return { failures, totals };
}

function tail(text, lines = TAIL_LINES) {
  const rows = String(text || '').split('\n');
  if (rows.length <= lines) return rows.join('\n');
  return [`[showing last ${lines} of ${rows.length} output lines]`, ...rows.slice(-lines)].join('\n');
}

export function formatTestReport({ command, framework, source, exitCode, output }) {
  const parsed = parseTestOutput(output);
  const totals = parsed.totals;
  const totalsLine = ['passed', 'failed', 'skipped']
    .filter((key) => Number.isFinite(totals[key]))
    .map((key) => `${totals[key]} ${key}`)
    .join(', ');

  const header = [
    `status: ${exitCode === 0 ? 'PASSED' : 'FAILED'} (exit=${exitCode})`,
    `command: ${command}`,
    framework && framework !== 'unknown' ? `framework: ${framework}` : '',
    source ? `detected via: ${source}` : '',
    totalsLine ? `totals: ${totalsLine}` : '',
  ].filter(Boolean);

  if (parsed.failures.length) {
    const shown = parsed.failures.slice(0, MAX_FAILURES_REPORTED);
    header.push(`failing tests (${parsed.failures.length}):`);
    shown.forEach((failure, index) => {
      header.push(`  ${index + 1}. ${failure.name}${failure.file ? ` [${failure.file}]` : ''}`);
    });
    if (parsed.failures.length > shown.length) {
      header.push(`  ...and ${parsed.failures.length - shown.length} more`);
    }
  } else if (exitCode !== 0) {
    // A non-zero exit with no recognised failure lines usually means the runner
    // itself failed to start. Say so instead of implying the suite is green.
    header.push('No individual test failures were recognised in the output; the runner itself may have failed to start.');
  }

  return {
    text: [header.join('\n'), '', '--- output ---', tail(output)].join('\n'),
    failures: parsed.failures,
    totals,
  };
}
