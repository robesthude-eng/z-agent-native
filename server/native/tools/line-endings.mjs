// Line endings and byte-order mark for the `edit` tool.
//
// Ported from opencode (https://github.com/sst/opencode,
// packages/opencode/src/tool/edit.ts and src/util/bom.ts), MIT License,
// Copyright (c) 2025 opencode. Models write "\n" even when the file uses
// "\r\n", so without this the text of an edit either does not match or - through
// the tolerant matcher - is spliced in with "\n" between "\r\n" lines.
//
// Adapted for z-agent: the file's line ending is the dominant one (opencode
// switches to CRLF as soon as a single "\r\n" is present, which would turn
// every edit of a mostly-LF file with one stray CRLF into CRLF text).

const BOM = '\uFEFF';

export function splitBom(text) {
  return text.charCodeAt(0) === 0xfeff ? { bom: true, text: text.slice(1) } : { bom: false, text };
}

export function joinBom(text, bom) {
  const stripped = splitBom(text).text;
  return bom ? BOM + stripped : stripped;
}

export function normalizeLineEndings(text) {
  return text.replaceAll('\r\n', '\n');
}

/** "\r\n" when most of the file's line breaks are CRLF, "\n" otherwise (also for a file without line breaks). */
export function detectLineEnding(text) {
  const crlf = text.split('\r\n').length - 1;
  if (crlf === 0) return '\n';
  const lf = text.split('\n').length - 1 - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

export function convertToLineEnding(text, ending) {
  const normalized = normalizeLineEndings(text);
  return ending === '\n' ? normalized : normalized.replaceAll('\n', ending);
}
