import assert from 'node:assert/strict';
import test from 'node:test';
import { findEditMatch } from '../server/native/tools/edit-match.mjs';

test('exact unique match', () => {
  const m = findEditMatch('a\nb\nc\n', 'b');
  assert.equal(m.strategy, 'exact');
  assert.equal(m.index, 2);
});

test('exact ambiguous match without all fails, with all succeeds', () => {
  assert.throws(() => findEditMatch('x\nx\n', 'x'), /several places/);
  assert.equal(findEditMatch('x\nx\n', 'x', { all: true }).occurrences, 2);
});

test('missing text gives actionable error', () => {
  assert.throws(() => findEditMatch('abc', 'zzz'), /not found/);
  assert.throws(() => findEditMatch('abc', ''), /must not be empty/);
});

test('indentation differences are tolerated', () => {
  const content = 'function f() {\n    if (x) {\n        run();\n    }\n}\n';
  const m = findEditMatch(content, 'if (x) {\n    run();\n}');
  assert.notEqual(m.strategy, 'exact');
  assert.equal(m.search, '    if (x) {\n        run();\n    }');
});

test('line-trimmed match returns the file own text', () => {
  const m = findEditMatch('  const a = 1;\n  const b = 2;\n', 'const a = 1;\nconst b = 2;');
  assert.equal(m.search, '  const a = 1;\n  const b = 2;');
});

test('block anchors tolerate a slightly different middle', () => {
  const content = 'start {\n  alpha beta gamma\n  delta\n}\n';
  const m = findEditMatch(content, 'start {\n  alpha beta gamna\n  delta\n}');
  assert.equal(m.strategy, 'block-anchor');
});

test('disproportionately large fuzzy match is refused', () => {
  const body = Array.from({ length: 30 }, (_, i) => `  line ${i}`).join('\n');
  const content = `top {\n${body}\n}\n`;
  assert.throws(() => findEditMatch(content, 'top {\n}'), /(Refusing|not found)/);
});
