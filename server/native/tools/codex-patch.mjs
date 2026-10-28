// The "*** Begin Patch" format of the `apply_patch` tool: parsing it and applying the hunks of an updated file to text
// in memory. Nothing here touches the file system; apply-codex-patch.mjs does that.
//
// Ported from opencode (https://github.com/sst/opencode, packages/opencode/src/patch/index.ts and
// src/tool/apply_patch.ts), MIT License, Copyright (c) 2025 opencode, which follows the apply-patch format of OpenAI
// Codex (https://github.com/openai/codex, Apache License 2.0): the grammar, the `@@` context line, matching of the
// old lines in four passes (exact, trailing whitespace, both ends, Unicode punctuation) and the rule that a hunk with
// only added lines goes to the end of the file come from there.
//
// Adapted for z-agent:
// - the parser is strict. An unknown line, a missing "*** End Patch" (the usual sign of a cut-off tool call) or a
//   malformed hunk is an error that names the line, instead of being skipped and applied half-way;
// - unchanged lines are never rewritten: whatever the matcher tolerated (indentation, trailing spaces, typographic
//   quotes), the file keeps its own text outside the removed and added lines;
// - line endings are kept per line (a CRLF file stays CRLF, added lines use the dominant ending), a BOM is kept, and a
//   file without a final newline does not get one unless the patch changes its last line;
// - hunks may overlap in their unchanged context (models repeat it between neighbouring changes), and a hunk that
//   cannot be found says whether the same lines exist earlier in the file, which is how out-of-order hunks look.

import { detectLineEnding, joinBom, splitBom } from './line-endings.mjs';

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File:';
const DELETE = '*** Delete File:';
const UPDATE = '*** Update File:';
const MOVE = '*** Move to:';
const END_OF_FILE = '*** End of File';

const SHOWN_LINES = 12;

const FENCE = /^```[\w+-]*[ \t]*\n([\s\S]*?)\n[ \t]*```$/;
const HEREDOC =
  /^[^\n]*\b(?:apply_patch|applypatch|cat)\b[^\n]*<<-?[ \t]*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n([\s\S]*?)\n[ \t]*\2[ \t]*(?:\n[\s\S]*)?$/;
const UNIFIED_RANGE = /^\s*-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s*@@(.*)$/;

function firstLine(text) {
  const end = text.indexOf('\n');
  return (end === -1 ? text : text.slice(0, end)).trimEnd();
}

function clip(text, max = 120) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function fail(line, message) {
  return new Error(`Invalid patch, line ${line}: ${message}`);
}

/**
 * The patch text without what models wrap around it: a BOM, CRLF line breaks, a markdown fence or a shell heredoc
 * (`apply_patch <<'EOF' ... EOF`).
 */
export function extractCodexPatch(input) {
  let text = String(input ?? '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replaceAll('\r\n', '\n').trim();
  for (const [wrapper, group] of [
    [FENCE, 1],
    [HEREDOC, 3],
  ]) {
    if (firstLine(text) === BEGIN) break;
    const match = wrapper.exec(text);
    if (match) text = match[group].trim();
  }
  return text;
}

/** True when the text is a "*** Begin Patch" patch rather than a unified diff. */
export function isCodexPatch(input) {
  return firstLine(extractCodexPatch(input)) === BEGIN;
}

function isFileHeader(line) {
  return line.startsWith(ADD) || line.startsWith(DELETE) || line.startsWith(UPDATE);
}

function headerPath(line, prefix, number) {
  let value = line.slice(prefix.length).trim();
  if (value.length > 1 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1).trim();
  if (!value) throw fail(number, `'${prefix}' needs a file path`);
  return value;
}

/** The text after "@@": `@@ def run():` names a line to find first; `@@ -3,7 +3,8 @@ def run():` is a unified-diff range. */
function chunkContext(line) {
  let rest = line.slice(2);
  const unified = UNIFIED_RANGE.exec(rest);
  if (unified) rest = unified[1];
  if (rest.startsWith(' ')) rest = rest.slice(1);
  rest = rest.trimEnd();
  return rest.trim() === '' ? null : rest;
}

function parseAdd(lines, from, last, path, number) {
  let end = from;
  while (end < last && !lines[end].startsWith('***')) end += 1;
  let stop = end;
  while (stop > from && lines[stop - 1].trim() === '') stop -= 1;
  const content = [];
  for (let at = from; at < stop; at += 1) {
    const text = lines[at];
    if (text.startsWith('+')) content.push(text.slice(1));
    else if (text.trim() === '') content.push('');
    else if (!text.startsWith('\\')) throw fail(at + 1, `every line of an added file must start with '+', got '${clip(text)}'`);
  }
  return { hunk: { type: 'add', path, content: content.length ? `${content.join('\n')}\n` : '', line: number }, next: end };
}

function parseOperation(text, at) {
  if (text === '') return { t: ' ', s: '' };
  const mark = text[0];
  if (mark === ' ' || mark === '-' || mark === '+') return { t: mark, s: text.slice(1) };
  // An unchanged line of a tab-indented file whose leading space the model left out: the whole line is the content.
  if (mark === '\t') return { t: ' ', s: text };
  if (text.startsWith('***')) {
    throw fail(
      at,
      text.trimEnd() === END
        ? `'${END}' may appear only once, as the last line of the patch`
        : `unknown line '${clip(text)}': a new file section starts with '${ADD}', '${UPDATE}' or '${DELETE}'`,
    );
  }
  throw fail(
    at,
    `lines of an Update File hunk must start with ' ' (unchanged), '-' (removed) or '+' (added), got '${clip(text)}'. ` +
      `A new hunk starts with '@@'.`,
  );
}

function parseUpdate(lines, from, last, path, number) {
  let at = from;
  let movePath = null;
  if (at < last && lines[at].startsWith(MOVE)) {
    movePath = headerPath(lines[at], MOVE, at + 1);
    at += 1;
  }
  const chunks = [];
  let chunk = null;
  for (; at < last && !isFileHeader(lines[at]); at += 1) {
    const text = lines[at];
    const row = at + 1;
    if (text.startsWith('\\')) continue; // "\ No newline at end of file"
    if (text.startsWith('@@')) {
      if (chunk) chunks.push(chunk);
      chunk = { context: chunkContext(text), ops: [], eof: false, line: row };
      continue;
    }
    if (text.trimEnd() === END_OF_FILE) {
      if (!chunk || chunk.ops.length === 0) throw fail(row, `'${END_OF_FILE}' must follow the lines of a hunk`);
      chunk.eof = true;
      chunks.push(chunk);
      chunk = null;
      continue;
    }
    if (chunk === null) {
      if (text.trim() === '') continue;
      // The first hunk of a file may omit "@@"; every later one needs it.
      if (chunks.length > 0) throw fail(row, `expected '@@' before further changes of this file, got '${clip(text)}'`);
      chunk = { context: null, ops: [], eof: false, line: row };
    }
    chunk.ops.push(parseOperation(text, row));
  }
  if (chunk) chunks.push(chunk);
  const lastChunk = chunks.at(-1);
  if (lastChunk && lastChunk.ops.length === 0) throw fail(lastChunk.line, `the '@@' hunk of ${path} has no lines`);
  if (!lastChunk && !movePath) throw fail(number, `'${UPDATE} ${path}' has no changes (expected '@@' hunks, or '${MOVE}' to rename)`);
  return { hunk: { type: 'update', path, movePath, chunks, line: number }, next: at };
}

/**
 * Parse a "*** Begin Patch" patch into `{ type: 'add' | 'delete' | 'update', path, ... }` hunks.
 * Throws an Error that names the offending line.
 */
export function parseCodexPatch(input) {
  const lines = extractCodexPatch(input).split('\n');
  if (lines[0].trimEnd() !== BEGIN) throw fail(1, `the patch must start with '${BEGIN}'`);
  const last = lines.length - 1;
  if (last === 0 || lines[last].trimEnd() !== END) {
    throw fail(
      lines.length,
      `the patch must end with '${END}'. A patch that stops earlier was most likely cut off: send it again in full.`,
    );
  }
  const hunks = [];
  let at = 1;
  while (at < last) {
    const line = lines[at];
    const number = at + 1;
    if (line.trim() === '') {
      at += 1;
    } else if (line.startsWith(ADD)) {
      const { hunk, next } = parseAdd(lines, at + 1, last, headerPath(line, ADD, number), number);
      hunks.push(hunk);
      at = next;
    } else if (line.startsWith(DELETE)) {
      hunks.push({ type: 'delete', path: headerPath(line, DELETE, number), line: number });
      at += 1;
    } else if (line.startsWith(UPDATE)) {
      const { hunk, next } = parseUpdate(lines, at + 1, last, headerPath(line, UPDATE, number), number);
      hunks.push(hunk);
      at = next;
    } else {
      const hint = line.trimEnd() === END ? ` Put every change into one patch with a single '${END}' at the end.` : '';
      throw fail(number, `expected '${ADD}', '${UPDATE}' or '${DELETE}', got '${clip(line)}'.${hint}`);
    }
  }
  if (hunks.length === 0) throw new Error(`Invalid patch: it changes no files (nothing between '${BEGIN}' and '${END}')`);
  return hunks;
}

// Matching -----------------------------------------------------------------------------------------------------------

function normalizeUnicode(text) {
  return text
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

const SAME = [
  (a, b) => a === b,
  (a, b) => a.trimEnd() === b.trimEnd(),
  (a, b) => a.trim() === b.trim(),
  (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()),
];

/**
 * Index of the first place at or after `start` where `pattern` matches `lines`, or -1. The four passes go from strict
 * to tolerant, so an exact match anywhere wins over a whitespace-insensitive one nearer to `start`. With `eof` the end
 * of the file is tried first.
 */
export function seekSequence(lines, pattern, start, eof = false) {
  if (pattern.length === 0) return start;
  const last = lines.length - pattern.length;
  if (last < start) return -1;
  for (const same of SAME) {
    const matchesAt = (at) => pattern.every((line, offset) => same(lines[at + offset], line));
    if (eof && matchesAt(last)) return last;
    for (let at = start; at <= last; at += 1) if (matchesAt(at)) return at;
  }
  return -1;
}

function splitLines(text) {
  const lines = [];
  let start = 0;
  for (const match of text.matchAll(/\r?\n/g)) {
    lines.push({ text: text.slice(start, match.index), eol: match[0] });
    start = match.index + match[0].length;
  }
  if (start < text.length) lines.push({ text: text.slice(start), eol: '' });
  return lines;
}

function quote(lines) {
  const shown = lines.slice(0, SHOWN_LINES).map((line) => `  ${clip(line, 200)}`);
  if (lines.length > SHOWN_LINES) shown.push(`  … and ${lines.length - SHOWN_LINES} more lines`);
  return shown.join('\n');
}

/**
 * Apply the hunks of one "Update File" section to `originalText`.
 * Returns `{ text, changes: [{ line, added, removed }], added, removed, notes }`; `line` is the first changed line of
 * the new text. Throws an Error that tells the model what to fix when a hunk cannot be placed.
 */
export function applyChunks(originalText, chunks, label = 'the file') {
  const source = splitBom(originalText);
  const lines = splitLines(source.text);
  const texts = lines.map((line) => line.text);
  const ending = detectLineEnding(source.text);
  let out = [];
  const appended = [];
  const changes = [];
  const notes = [];
  let copied = 0; // original lines before this index are already in `out`
  let searchFrom = 0;
  let added = 0;
  let removed = 0;

  chunks.forEach((chunk, index) => {
    const number = index + 1;
    let contextAt = -1;
    if (chunk.context) {
      const found = seekSequence(texts, [chunk.context], searchFrom);
      if (found === -1) {
        throw new Error(
          `Could not find the line '${clip(chunk.context)}' that follows '@@' (change ${number}) in ${label}. ` +
            `Copy the line from the file exactly, or leave the '@@' line empty and let the unchanged lines around the change locate it.`,
        );
      }
      contextAt = found;
      searchFrom = found + 1;
    }
    if (chunk.ops.length === 0) return;

    let ops = chunk.ops;
    let wanted = ops.filter((op) => op.t !== '+').map((op) => op.s);
    if (wanted.length === 0) {
      appended.push({ chunk, number });
      return;
    }
    // Models often repeat the '@@' line as the first unchanged line; that line itself is a valid place to start.
    const locate = (pattern) => {
      const found = seekSequence(texts, pattern, searchFrom, chunk.eof);
      return found === -1 && contextAt !== -1 ? seekSequence(texts, pattern, contextAt, chunk.eof) : found;
    };
    let at = locate(wanted);
    if (at === -1) {
      // Blank lines the model put after the last unchanged line (often just the gap before the next hunk) are not in a
      // file that ends there.
      let keep = ops.length;
      while (keep > 1 && ops[keep - 1].t === ' ' && ops[keep - 1].s === '') keep -= 1;
      const shorter = ops.slice(0, keep).filter((op) => op.t !== '+');
      if (keep < ops.length && shorter.length > 0) {
        const found = locate(shorter.map((op) => op.s));
        if (found !== -1) {
          at = found;
          ops = ops.slice(0, keep);
          wanted = shorter.map((op) => op.s);
        }
      }
    }
    if (at === -1) {
      const earlier = searchFrom > 0 ? seekSequence(texts, wanted, 0, chunk.eof) : -1;
      throw new Error(
        `Could not find the expected lines of change ${number} in ${label}${chunk.eof ? ' (expected at the end of the file)' : ''}:\n${quote(wanted)}\n` +
          (earlier !== -1 && earlier < searchFrom
            ? `The same lines are at line ${earlier + 1}, before the previous change: list the changes of a file in file order, or merge neighbouring changes into one hunk.`
            : `Read the file again and copy these lines exactly (a line that starts with ' ', '-' or '+' must match the file after that character).`),
      );
    }

    // Consecutive '-' and '+' lines form one edit; unchanged lines between edits stay untouched in the file.
    let position = at;
    let edit = null;
    const edits = [];
    for (const op of ops) {
      if (op.t === ' ') {
        edit = null;
        position += 1;
        continue;
      }
      if (!edit) {
        edit = { start: position, remove: 0, insert: [] };
        edits.push(edit);
      }
      if (op.t === '-') {
        edit.remove += 1;
        position += 1;
      } else {
        edit.insert.push({ text: op.s, eol: ending });
      }
    }
    for (const run of edits) {
      while (copied < run.start) out.push(lines[copied++]);
      changes.push({ line: out.length + 1, added: run.insert.length, removed: run.remove });
      for (const line of run.insert) out.push(line);
      copied = run.start + run.remove;
      added += run.insert.length;
      removed += run.remove;
    }
    // The next hunk may repeat unchanged lines that follow the last edit, but not touch anything before it.
    searchFrom = edits.length ? edits.at(-1).start + edits.at(-1).remove : at + wanted.length;
  });

  while (copied < lines.length) out.push(lines[copied++]);

  if (appended.length) {
    let position = out.length;
    const finalLine = lines.at(-1);
    if (finalLine && finalLine.text === '' && out.at(-1) === finalLine) position -= 1;
    const inserted = [];
    for (const { chunk, number } of appended) {
      const run = chunk.ops.map((op) => ({ text: op.s, eol: ending }));
      changes.push({ line: position + inserted.length + 1, added: run.length, removed: 0 });
      for (const line of run) inserted.push(line);
      added += run.length;
      if (chunk.context) {
        notes.push(
          `Change ${number} has only added lines, so it was appended at the end of ${label}: an '@@' line only narrows where later changes are searched. ` +
            `To insert lines elsewhere, add unchanged lines around the spot.`,
        );
      }
    }
    out = [...out.slice(0, position), ...inserted, ...out.slice(position)];
  }

  // Only the original last line can lack a line break, and it needs one as soon as something follows it.
  const text = out.map((line, at) => line.text + (line.eol === '' && at < out.length - 1 ? ending : line.eol)).join('');
  changes.sort((a, b) => a.line - b.line);
  return { text: joinBom(text, source.bom), changes, added, removed, notes };
}
