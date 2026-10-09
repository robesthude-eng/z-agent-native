import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeEditFile } from '../server/native/tools/filesystem.mjs';
import { convertToLineEnding, detectLineEnding, joinBom, normalizeLineEndings, splitBom } from '../server/native/tools/line-endings.mjs';

const roots = [];
function workspace(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-line-endings-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  return root;
}
const read = (root, name) => fs.readFileSync(path.join(root, name));
test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('line-ending helpers', () => {
  assert.equal(detectLineEnding(''), '\n');
  assert.equal(detectLineEnding('no breaks'), '\n');
  assert.equal(detectLineEnding('a\nb\n'), '\n');
  assert.equal(detectLineEnding('a\r\nb\r\n'), '\r\n');
  assert.equal(detectLineEnding('a\r\nb\nc\nd\n'), '\n', 'a stray CRLF does not turn an LF file into CRLF');
  assert.equal(detectLineEnding('a\r\nb\r\nc\nd'), '\r\n');
  assert.equal(convertToLineEnding('a\nb', '\r\n'), 'a\r\nb');
  assert.equal(convertToLineEnding('a\r\nb\nc', '\r\n'), 'a\r\nb\r\nc', 'never produces \\r\\r\\n');
  assert.equal(convertToLineEnding('a\r\nb', '\n'), 'a\nb');
  assert.equal(normalizeLineEndings('a\r\nb\rc\n'), 'a\nb\rc\n');
  assert.deepEqual(splitBom('\uFEFFabc'), { bom: true, text: 'abc' });
  assert.deepEqual(splitBom('abc'), { bom: false, text: 'abc' });
  assert.equal(joinBom('\uFEFFabc', true), '\uFEFFabc');
  assert.equal(joinBom('abc', true), '\uFEFFabc');
  assert.equal(joinBom('\uFEFFabc', false), 'abc');
});

test('editing a CRLF file with LF text keeps every line break CRLF', () => {
  const root = workspace({ 'a.txt': 'one\r\ntwo\r\nthree\r\n' });
  const result = executeEditFile(root, { path: 'a.txt', oldText: 'one\ntwo\n', newText: 'one\nTWO\nTWO-B\n' });
  assert.equal(read(root, 'a.txt').toString('utf8'), 'one\r\nTWO\r\nTWO-B\r\nthree\r\n');
  assert.doesNotMatch(result.output, /matched by/, 'the multi-line text now matches exactly');
  assert.doesNotMatch(result.output, /\r/, 'the preview shown to the model carries no carriage returns');
  assert.match(result.output, /File now has 4 lines/);
});

// The same edit on an LF file and on its CRLF twin must give the same text, apart from the line endings.
function assertTwinEdit(content, input, strategy) {
  const lf = workspace({ 'f.txt': content });
  const crlf = workspace({ 'f.txt': content.replaceAll('\n', '\r\n') });
  const lfResult = executeEditFile(lf, { path: 'f.txt', ...input });
  const crlfResult = executeEditFile(crlf, { path: 'f.txt', ...input });
  const lfText = read(lf, 'f.txt').toString('utf8');
  const crlfText = read(crlf, 'f.txt').toString('utf8');
  assert.equal(crlfText, lfText.replaceAll('\n', '\r\n'));
  assert.doesNotMatch(crlfText, /(?<!\r)\n/, 'no bare LF in the CRLF file');
  assert.equal(crlfResult.output, lfResult.output, 'the model sees the same result for both files');
  if (strategy) assert.match(crlfResult.output, new RegExp(`matched by ${strategy}`));
  else assert.doesNotMatch(crlfResult.output, /matched by/);
}

test('tolerant matches in a CRLF file behave like they do in its LF twin', () => {
  // indentation differs
  assertTwinEdit(
    'function f() {\n    if (x) {\n        run();\n    }\n}\n',
    { oldText: 'if (x) {\n    run();\n}', newText: '    if (y) {\n        stop();\n    }' },
    'line-trimmed',
  );
  // the model's copy differs in the middle line, anchors on the first and last line
  assertTwinEdit(
    'start {\n  alpha beta gamma\n  delta\n}\n',
    { oldText: 'start {\n  alpha beta gamna\n  delta\n}', newText: 'start {\n  done\n}' },
    'block-anchor',
  );
  // an exact multi-line text
  assertTwinEdit('a\nb\nc\nd\n', { oldText: 'b\nc', newText: 'B\nC\nC2' });
  // a deletion
  assertTwinEdit('a\nb\nc\n', { oldText: 'b\n', newText: '' });
});

test('all=true in a CRLF file converts the replacement everywhere', () => {
  const root = workspace({ 'a.txt': 'x = 1\r\ny\r\nmid\r\nx = 1\r\ny\r\n' });
  const result = executeEditFile(root, { path: 'a.txt', oldText: 'x = 1\ny', newText: 'x = 2\nw', all: true });
  assert.equal(read(root, 'a.txt').toString('utf8'), 'x = 2\r\nw\r\nmid\r\nx = 2\r\nw\r\n');
  assert.match(result.output, /replaced 2 occurrences/);
});

test('LF files are unchanged by the line-ending handling', () => {
  const root = workspace({ 'a.txt': 'one\ntwo\nthree\n' });
  executeEditFile(root, { path: 'a.txt', oldText: 'two', newText: 'TWO\nTWO-B' });
  assert.equal(read(root, 'a.txt').toString('utf8'), 'one\nTWO\nTWO-B\nthree\n');
  // CRLF typed by the model into an LF file does not leak into it.
  executeEditFile(root, { path: 'a.txt', oldText: 'three', newText: 'three\r\nfour' });
  assert.equal(read(root, 'a.txt').toString('utf8'), 'one\nTWO\nTWO-B\nthree\nfour\n');
});

test('a mostly-LF file with one stray CRLF stays LF', () => {
  const root = workspace({ 'a.txt': 'a\r\nb\nc\nd\n' });
  executeEditFile(root, { path: 'a.txt', oldText: 'c\nd', newText: 'c\nD\nE' });
  assert.equal(read(root, 'a.txt').toString('utf8'), 'a\r\nb\nc\nD\nE\n');
});

test('a UTF-8 BOM survives an edit, also when the model copied it from the first line', () => {
  const root = workspace({ 'a.csv': '\uFEFFid,name\n1,Ann\n' });
  executeEditFile(root, { path: 'a.csv', oldText: '1,Ann', newText: '1,Anna' });
  assert.deepEqual([...read(root, 'a.csv').subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(read(root, 'a.csv').toString('utf8'), '\uFEFFid,name\n1,Anna\n');

  executeEditFile(root, { path: 'a.csv', oldText: '\uFEFFid,name', newText: '\uFEFFid,title' });
  const bytes = read(root, 'a.csv');
  assert.equal(bytes.toString('utf8'), '\uFEFFid,title\n1,Anna\n');
  assert.notDeepEqual([...bytes.subarray(3, 6)], [0xef, 0xbb, 0xbf], 'only one BOM');
});

test('a tolerant match that starts at the top of the file keeps the BOM', () => {
  const root = workspace({ 'a.js': '\uFEFFfunction f() {\n    run();\n}\n' });
  const result = executeEditFile(root, { path: 'a.js', oldText: 'function f() {\n  run();\n}', newText: 'function g() {\n    stop();\n}' });
  assert.match(result.output, /matched by/);
  assert.equal(read(root, 'a.js').toString('utf8'), '\uFEFFfunction g() {\n    stop();\n}\n');
});

test('BOM and CRLF together', () => {
  const root = workspace({ 'a.txt': '\uFEFFfirst\r\nsecond\r\n' });
  executeEditFile(root, { path: 'a.txt', oldText: 'first\nsecond', newText: 'first\nsecond\nthird' });
  assert.equal(read(root, 'a.txt').toString('utf8'), '\uFEFFfirst\r\nsecond\r\nthird\r\n');
});

test('a file without a BOM does not gain one', () => {
  const root = workspace({ 'a.txt': 'alpha\nbeta\n' });
  executeEditFile(root, { path: 'a.txt', oldText: 'alpha', newText: 'ALPHA' });
  assert.notEqual(read(root, 'a.txt')[0], 0xef);
  assert.equal(read(root, 'a.txt').toString('utf8'), 'ALPHA\nbeta\n');
});
