import fs from 'node:fs';
import path from 'node:path';

const MAX_DIAGNOSTICS_REPORTED = 60;
const TAIL_LINES = 80;

export const DIAGNOSTIC_KINDS = ['all', 'typecheck', 'lint'];

/**
 * Planning and parsing only; tools.mjs runs the commands through the same
 * sandboxed shell path as bash. A real LSP client is intentionally out of
 * scope: the project's own typecheck/lint commands already encode the exact
 * compiler and rule configuration, and shelling out to them cannot drift.
 */

function readManifestScripts(root) {
  const packageFile = path.join(root, 'package.json');
  if (!fs.existsSync(packageFile)) return {};
  try {
    const manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
    return manifest?.scripts && typeof manifest.scripts === 'object' ? manifest.scripts : {};
  } catch {
    return {};
  }
}

function exists(root, ...names) {
  return names.some((name) => fs.existsSync(path.join(root, name)));
}

export function detectTypecheckCommand(root) {
  const scripts = readManifestScripts(root);
  if (typeof scripts.typecheck === 'string' && scripts.typecheck.trim()) {
    return { kind: 'typecheck', command: 'npm run typecheck', source: 'package.json scripts.typecheck' };
  }
  if (exists(root, 'tsconfig.json')) {
    return { kind: 'typecheck', command: 'npx --no-install tsc --noEmit', source: 'tsconfig.json' };
  }
  if (exists(root, 'go.mod')) {
    return { kind: 'typecheck', command: 'go vet ./...', source: 'go module' };
  }
  if (exists(root, 'Cargo.toml')) {
    return { kind: 'typecheck', command: 'cargo check', source: 'cargo manifest' };
  }
  if (exists(root, 'mypy.ini') || exists(root, 'pyproject.toml')) {
    return { kind: 'typecheck', command: 'mypy .', source: 'python project' };
  }
  return null;
}

export function detectLintCommand(root) {
  const scripts = readManifestScripts(root);
  if (typeof scripts.lint === 'string' && scripts.lint.trim()) {
    return { kind: 'lint', command: 'npm run lint', source: 'package.json scripts.lint' };
  }
  if (exists(root, 'biome.json', 'biome.jsonc')) {
    return { kind: 'lint', command: 'npx --no-install biome check .', source: 'biome config' };
  }
  if (exists(root, 'eslint.config.js', 'eslint.config.mjs', '.eslintrc', '.eslintrc.json', '.eslintrc.cjs')) {
    return { kind: 'lint', command: 'npx --no-install eslint .', source: 'eslint config' };
  }
  if (exists(root, 'ruff.toml', '.ruff.toml')) {
    return { kind: 'lint', command: 'ruff check .', source: 'ruff config' };
  }
  return null;
}

export function planDiagnostics(root, input = {}) {
  const requested = String(input.kind || 'all').trim().toLowerCase();
  if (!DIAGNOSTIC_KINDS.includes(requested)) {
    throw new Error(`Unsupported diagnostics kind "${input.kind}". Use one of: ${DIAGNOSTIC_KINDS.join(', ')}`);
  }
  const explicit = String(input.command || '').trim();
  if (explicit) {
    return [{ kind: requested === 'all' ? 'lint' : requested, command: explicit, source: 'explicit command' }];
  }
  const plans = [];
  if (requested === 'all' || requested === 'typecheck') {
    const typecheck = detectTypecheckCommand(root);
    if (typecheck) plans.push(typecheck);
  }
  if (requested === 'all' || requested === 'lint') {
    const lint = detectLintCommand(root);
    if (lint) plans.push(lint);
  }
  if (!plans.length) {
    throw new Error('No typecheck or lint command could be detected. Pass command explicitly, for example command="npx tsc --noEmit".');
  }
  return plans;
}

function pushDiagnostic(list, seen, entry) {
  const file = String(entry.file || '').trim();
  const message = String(entry.message || '').trim();
  if (!file || !message) return;
  const line = Number.isFinite(entry.line) ? entry.line : 0;
  const column = Number.isFinite(entry.column) ? entry.column : 0;
  const key = `${file}:${line}:${column}:${message}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push({
    file,
    line,
    column,
    severity: entry.severity === 'warning' ? 'warning' : 'error',
    ...(entry.code ? { code: entry.code } : {}),
    message,
  });
}

export function parseDiagnostics(text) {
  const body = String(text || '');
  const diagnostics = [];
  const seen = new Set();

  // tsc default: src/a.ts(12,5): error TS2345: message
  for (const match of body.matchAll(/^(\S+?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.+)$/gm)) {
    pushDiagnostic(diagnostics, seen, {
      file: match[1], line: Number(match[2]), column: Number(match[3]),
      severity: match[4], code: match[5], message: match[6],
    });
  }

  // tsc pretty: src/a.ts:12:5 - error TS2345: message
  for (const match of body.matchAll(/^(\S+?):(\d+):(\d+)\s*-\s*(error|warning)\s+(TS\d+):\s*(.+)$/gm)) {
    pushDiagnostic(diagnostics, seen, {
      file: match[1], line: Number(match[2]), column: Number(match[3]),
      severity: match[4], code: match[5], message: match[6],
    });
  }

  // gcc/mypy/ruff style: file:12:5: error: message
  for (const match of body.matchAll(/^(\S+?):(\d+):(\d+):\s*(error|warning|note)\s*:?\s*(.+)$/gm)) {
    if (match[4] === 'note') continue;
    pushDiagnostic(diagnostics, seen, {
      file: match[1], line: Number(match[2]), column: Number(match[3]),
      severity: match[4], message: match[5],
    });
  }

  // biome: path/file.ts:12:5 lint/suspicious/noExplicitAny
  for (const match of body.matchAll(/^(\S+?):(\d+):(\d+)\s+(lint\/\S+|parse|format)\s/gm)) {
    pushDiagnostic(diagnostics, seen, {
      file: match[1], line: Number(match[2]), column: Number(match[3]),
      severity: 'error', code: match[4], message: match[4],
    });
  }

  // eslint stylish: a file header line followed by indented "12:5  error  msg  rule"
  let currentFile = '';
  for (const rawLine of body.split('\n')) {
    const header = rawLine.match(/^(?:\/|\.\/|[A-Za-z]:\\)?[^\s:]+\.[A-Za-z]{1,5}$/);
    if (header) {
      currentFile = rawLine.trim();
      continue;
    }
    const row = rawLine.match(/^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)(?:\s\s+(\S+))?\s*$/);
    if (row && currentFile) {
      pushDiagnostic(diagnostics, seen, {
        file: currentFile, line: Number(row[1]), column: Number(row[2]),
        severity: row[3], code: row[5], message: row[4],
      });
    }
  }

  return diagnostics;
}

function tail(text, lines = TAIL_LINES) {
  const rows = String(text || '').split('\n');
  if (rows.length <= lines) return rows.join('\n');
  return [`[showing last ${lines} of ${rows.length} output lines]`, ...rows.slice(-lines)].join('\n');
}

export function formatDiagnosticsReport(runs) {
  const sections = [];
  const all = [];
  let anyFailed = false;

  for (const run of runs) {
    const parsed = parseDiagnostics(run.output);
    for (const item of parsed) all.push({ ...item, kind: run.kind });
    if (run.exitCode !== 0) anyFailed = true;

    const lines = [
      `[${run.kind}] ${run.exitCode === 0 ? 'clean' : 'issues found'} (exit=${run.exitCode})`,
      `  command: ${run.command}`,
      run.source ? `  detected via: ${run.source}` : '',
      `  parsed diagnostics: ${parsed.length}`,
    ].filter(Boolean);

    if (run.exitCode !== 0 && parsed.length === 0) {
      // Distinguish "tool could not run" from "code is clean": a missing binary
      // must never be reported as a passing check.
      lines.push('  no diagnostics were parsed, so the checker itself may have failed to start');
      lines.push(`  output tail:\n${tail(run.output, 30).split('\n').map((row) => `    ${row}`).join('\n')}`);
    }
    sections.push(lines.join('\n'));
  }

  const errors = all.filter((item) => item.severity === 'error');
  const warnings = all.filter((item) => item.severity === 'warning');
  const shown = [...errors, ...warnings].slice(0, MAX_DIAGNOSTICS_REPORTED);

  const header = [
    `status: ${!anyFailed && all.length === 0 ? 'CLEAN' : 'ISSUES'}`,
    `totals: ${errors.length} error(s), ${warnings.length} warning(s)`,
  ];

  if (shown.length) {
    header.push('', 'diagnostics:');
    shown.forEach((item, index) => {
      const where = item.line ? `${item.file}:${item.line}:${item.column}` : item.file;
      header.push(`  ${index + 1}. [${item.severity}] ${where}${item.code ? ` ${item.code}` : ''} — ${item.message}`);
    });
    if (all.length > shown.length) header.push(`  ...and ${all.length - shown.length} more`);
  }

  return {
    text: [header.join('\n'), '', sections.join('\n\n')].join('\n'),
    ok: !anyFailed,
    diagnostics: all,
    errorCount: errors.length,
    warningCount: warnings.length,
  };
}
