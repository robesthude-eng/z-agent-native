// Immediate syntax feedback after `write` / `edit`.
//
// opencode appends LSP diagnostics to the result of an edit
// (https://github.com/sst/opencode, packages/opencode/src/tool/edit.ts, MIT License,
// Copyright (c) 2025 opencode). A language server is too heavy here, so this
// reports only hard syntax errors that can be detected by parsing the file without
// executing it: JSON (in-process), JavaScript (`node --check`) and Python (`ast.parse`).
// Nothing is reported when the file is fine, so the common case costs no tokens.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 4000;
const SKIP = /(^|\/)(node_modules|\.agent-home|\.agent-skills|\.git|dist|build)(\/|$)/;
const JS_EXT = new Set(['.js', '.mjs', '.cjs']);
const PY_PROGRAM = 'import ast,sys\nast.parse(open(sys.argv[1],encoding="utf-8").read(),sys.argv[1])';

export function syntaxCheckEnabled(env = process.env) {
  return !['0', 'false', 'off', 'no'].includes(
    String(env.Z_AGENT_SYNTAX_CHECK ?? '1')
      .trim()
      .toLowerCase(),
  );
}

function run(file, args, cwd) {
  return new Promise((resolve) => {
    let stderr = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn(file, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH || '', LANG: 'C.UTF-8' } });
    } catch {
      return done(null);
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(null);
    }, TIMEOUT_MS);
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8000) stderr += chunk;
    });
    child.on('error', () => {
      clearTimeout(timer);
      done(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 ? '' : stderr.trim() || null);
    });
  });
}

function brief(text, root, fromEnd = false) {
  const lines = String(text)
    .split(root)
    .join('.')
    .split('\n')
    .filter((line) => line.trim() && !/^Node\.js v\d/.test(line));
  return (fromEnd ? lines.slice(-5) : lines.slice(0, 8)).join('\n');
}

/** Returns a short error report, or '' when the file parses (or cannot be checked). */
export async function checkSyntax(root, relPath) {
  if (!syntaxCheckEnabled() || !root || !relPath) return '';
  const rel = String(relPath).replace(/\\/g, '/');
  const ext = path.extname(rel).toLowerCase();
  if (SKIP.test(rel) || !(ext === '.json' || ext === '.py' || JS_EXT.has(ext))) return '';
  const full = path.resolve(root, rel);
  if (!full.startsWith(`${path.resolve(root)}${path.sep}`)) return '';
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return '';
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) return '';
  if (ext === '.json') {
    try {
      JSON.parse(fs.readFileSync(full, 'utf8'));
      return '';
    } catch (err) {
      return `${rel}: invalid JSON — ${err.message}`;
    }
  }
  const report =
    ext === '.py' ? await run('python3', ['-c', PY_PROGRAM, full], root) : await run(process.execPath, ['--check', full], root);
  return report ? `${rel}: syntax error\n${brief(report, path.resolve(root), ext === '.py')}` : '';
}

/** Appends a syntax warning to an edit/write result when the changed file no longer parses. */
export async function withSyntaxCheck(root, result) {
  const paths = Array.isArray(result?.mutatedPaths) ? result.mutatedPaths.filter((p) => p && p !== '.') : [];
  if (!paths.length) return result;
  const reports = (await Promise.all(paths.slice(0, 3).map((p) => checkSyntax(root, p)))).filter(Boolean);
  if (!reports.length) return result;
  return {
    ...result,
    output: `${result.output}\n\n⚠ Syntax check failed after this change — fix it before moving on:\n${reports.join('\n')}`,
    metadata: { ...(result.metadata || {}), syntaxError: true },
  };
}
