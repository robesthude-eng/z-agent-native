// Oversized tool output: keep a short preview in the model context and save the
// full text to a workspace file the agent can search with grep / read.
//
// The "managed tool-output file" idea is taken from opencode
// (https://github.com/sst/opencode, packages/opencode/src/tool/truncate.ts,
// MIT License, Copyright (c) 2025 opencode); this is an independent implementation.
import fs from 'node:fs';
import path from 'node:path';
import { syncSandboxOwnership } from './sandbox.mjs';

export const SPILL_DIR = '.agent-home/tool-output';
const DEFAULT_SPILL_CHARS = 32_000;
const HEAD_CHARS = 8_000;
const TAIL_CHARS = 4_000;
const MAX_FILES = 40;
const MAX_AGE_MS = 3 * 24 * 3600 * 1000;
// `read` is already paged by the model and reading a spill file must not spill again.
const SKIP_TOOLS = new Set(['read', 'view_media', 'screenshot']);

export function spillThreshold(env = process.env) {
  const n = Number(env.Z_AGENT_TOOL_SPILL_CHARS || DEFAULT_SPILL_CHARS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_SPILL_CHARS;
}

function pruneOld(dir, now) {
  try {
    const entries = fs
      .readdirSync(dir)
      .map((name) => {
        const full = path.join(dir, name);
        return { full, mtime: fs.statSync(full).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    entries.forEach((entry, i) => {
      if (i >= MAX_FILES || now - entry.mtime > MAX_AGE_MS) fs.rmSync(entry.full, { force: true });
    });
  } catch {
    // best effort
  }
}

/**
 * Returns `{ content, file }` with a head/tail preview when `text` is larger than the
 * threshold and the full text could be saved; otherwise null (caller keeps its output).
 */
export function spillLargeOutput({ workspace, sessionId, callId, toolName, text, now = Date.now(), threshold = spillThreshold() }) {
  const body = String(text ?? '');
  if (!workspace || !threshold || body.length <= threshold || SKIP_TOOLS.has(toolName)) return null;
  const safeCall =
    String(callId || 'call')
      .replace(/[^A-Za-z0-9_-]/g, '')
      .slice(0, 40) || 'call';
  const name = `${now}-${safeCall}.txt`;
  const dir = path.join(path.resolve(workspace), SPILL_DIR);
  const full = path.join(dir, name);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(full, body, { mode: 0o644 });
    if (sessionId) syncSandboxOwnership(sessionId, path.resolve(workspace), dir);
    pruneOld(dir, now);
  } catch {
    return null;
  }
  const file = `${SPILL_DIR}/${name}`;
  const omitted = body.length - HEAD_CHARS - TAIL_CHARS;
  const content = [
    body.slice(0, HEAD_CHARS),
    `\n\n[… ${omitted} chars omitted from the middle. Full output (${body.length} chars) is saved to ${file}. Search it with grep or read it with offset/limit instead of re-running the command.]\n\n`,
    body.slice(-TAIL_CHARS),
  ].join('');
  return { content, file };
}
