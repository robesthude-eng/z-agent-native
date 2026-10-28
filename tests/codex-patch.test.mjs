import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChunks, extractCodexPatch, isCodexPatch, parseCodexPatch, seekSequence } from '../server/native/tools/codex-patch.mjs';

const wrap = (body) => `*** Begin Patch\n${body}\n*** End Patch`;

function update(file, body, label = 'f.txt') {
  const [hunk] = parseCodexPatch(wrap(`*** Update File: ${label}\n${body}`));
  return applyChunks(file, hunk.chunks, label);
}

test('wrappers models put around a patch are removed, a unified diff is not mistaken for one', () => {
  const inner = '*** Begin Patch\n*** Delete File: a.txt\n*** End Patch';
  for (const text of [
    inner,
    `\n  \n${inner}\n\n`,
    inner.replaceAll('\n', '\r\n'),
    `\uFEFF${inner}`,
    `\`\`\`diff\n${inner}\n\`\`\``,
    `\`\`\`\n${inner}\n\`\`\`  `,
    `apply_patch <<'EOF'\n${inner}\nEOF`,
    `cat <<EOF | apply_patch\n${inner}\nEOF\n`,
    `bash -lc 'apply_patch <<"PATCH"\n${inner}\nPATCH\n'`,
  ]) {
    assert.equal(isCodexPatch(text), true, JSON.stringify(text));
    assert.equal(extractCodexPatch(text), inner);
  }
  assert.equal(isCodexPatch('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n'), false);
  assert.equal(isCodexPatch('diff --git a/x b/x\n--- a/x\n+++ b/x\n'), false);
  assert.equal(isCodexPatch(''), false);
  assert.equal(isCodexPatch(undefined), false);
  assert.equal(isCodexPatch('Here is the patch:\n*** Begin Patch\n*** End Patch'), false);
});

test('parseCodexPatch reads add, delete, update, move and hunk headers', () => {
  const hunks = parseCodexPatch(
    wrap(
      [
        '*** Add File: "docs/new file.md"',
        '+# Title',
        '',
        '+body',
        '',
        '*** Update File: src/x.js',
        '*** Move to: src/y.js',
        '@@ function foo()',
        ' a',
        '-b',
        '+B',
        '',
        '@@',
        ' d',
        '+e',
        '*** End of File',
        '*** Delete File: old.txt',
        '',
        '*** Update File: only-rename.txt',
        '*** Move to: renamed.txt',
      ].join('\n'),
    ),
  );
  assert.equal(hunks.length, 4);
  assert.deepEqual(hunks[0], { type: 'add', path: 'docs/new file.md', content: '# Title\n\nbody\n', line: 2 });
  const [first, second] = hunks[1].chunks;
  assert.equal(hunks[1].path, 'src/x.js');
  assert.equal(hunks[1].movePath, 'src/y.js');
  assert.equal(first.context, 'function foo()');
  assert.deepEqual(
    first.ops,
    [
      { t: ' ', s: 'a' },
      { t: '-', s: 'b' },
      { t: '+', s: 'B' },
      { t: ' ', s: '' },
    ],
    'a bare empty line inside a hunk is an empty unchanged line',
  );
  assert.equal(first.eof, false);
  assert.equal(second.context, null);
  assert.equal(second.eof, true);
  assert.equal(hunks[2].type, 'delete');
  assert.equal(hunks[2].path, 'old.txt');
  assert.deepEqual([hunks[3].path, hunks[3].movePath, hunks[3].chunks], ['only-rename.txt', 'renamed.txt', []]);
});

test('an unchanged line that starts with a tab (the leading space was left out) is taken whole', () => {
  const result = update('if (x) {\n\trun();\n}\n', ' if (x) {\n\trun();\n-}\n+} // end');
  assert.equal(result.text, 'if (x) {\n\trun();\n} // end\n');
});

test('an empty added file, "\\ No newline" markers and unified-diff hunk ranges are accepted', () => {
  const hunks = parseCodexPatch(
    wrap(
      [
        '*** Add File: empty.txt',
        '*** Add File: one.txt',
        '+only',
        '\\ No newline at end of file',
        '*** Update File: u.txt',
        '@@ -3,2 +3,3 @@ def run():',
        ' x',
        '-y',
        '\\ No newline at end of file',
        '+z',
        '@@ -10 +11 @@',
        '-q',
        '+r',
      ].join('\n'),
    ),
  );
  assert.equal(hunks[0].content, '');
  assert.equal(hunks[1].content, 'only\n');
  const [first, second] = hunks[2].chunks;
  assert.equal(first.context, 'def run():');
  assert.equal(second.context, null);
  assert.equal(first.ops.length, 3);
});

test('the first hunk of a file may omit @@, consecutive @@ lines narrow the search', () => {
  const [hunk] = parseCodexPatch(wrap('*** Update File: a.py\n x\n-y\n@@ class A\n@@ def m(self)\n-z\n+Z'));
  assert.equal(hunk.chunks.length, 3);
  assert.equal(hunk.chunks[0].context, null);
  assert.deepEqual(
    hunk.chunks.map((chunk) => [chunk.context, chunk.ops.length]),
    [
      [null, 2],
      ['class A', 0],
      ['def m(self)', 2],
    ],
  );
});

test('malformed patches are rejected with the offending line', () => {
  const bad = [
    ['*** Begin Patch\n*** Add File: a.txt\n+x', /line 3: the patch must end with '\*\*\* End Patch'.*cut off/],
    ['*** Begin Patch', /must end with/],
    ['*** Begin Patch\nfoo\n*** End Patch', /line 2: expected '\*\*\* Add File:'.*got 'foo'/],
    ['*** Begin Patch\n*** End Patch', /changes no files/],
    ['*** Begin Patch\n*** Add File:\n+x\n*** End Patch', /line 2: '\*\*\* Add File:' needs a file path/],
    ['*** Begin Patch\n*** Add File: a.txt\nplain text\n*** End Patch', /line 3: every line of an added file must start with '\+'/],
    ['*** Begin Patch\n*** Update File: a.txt\n*** End Patch', /line 2:.*has no changes/],
    ['*** Begin Patch\n*** Update File: a.txt\n@@ ctx\n*** End Patch', /line 3: the '@@' hunk of a\.txt has no lines/],
    ['*** Begin Patch\n*** Update File: a.txt\nunprefixed\n*** End Patch', /line 3: lines of an Update File hunk must start with/],
    ['*** Begin Patch\n*** Update File: a.txt\n@@\n x\n*** End of File\n+y\n*** End Patch', /line 6: expected '@@' before further changes/],
    ['*** Begin Patch\n*** Update File: a.txt\n@@\n*** End of File\n*** End Patch', /line 4: '\*\*\* End of File' must follow/],
    [
      '*** Begin Patch\n*** Update File: a.txt\n@@\n x\n*** End Patch\n*** Begin Patch\n*** End Patch',
      /line 5: '\*\*\* End Patch' may appear only once/,
    ],
    ['*** Begin Patch\n*** Update File: a.txt\n@@\n x\n*** Remove File: b\n*** End Patch', /line 5: unknown line '\*\*\* Remove File: b'/],
  ];
  for (const [text, pattern] of bad) assert.throws(() => parseCodexPatch(text), pattern, text);
  assert.throws(() => parseCodexPatch('--- a/x\n+++ b/x\n'), /must start with '\*\*\* Begin Patch'/);
});

test('seekSequence prefers an exact match, then looser ones, and honours the start and end of file', () => {
  const lines = ['  a  ', 'a', 'b', 'a'];
  assert.equal(seekSequence(lines, ['a'], 0), 1, 'exact beats an earlier whitespace-insensitive line');
  assert.equal(seekSequence(lines, ['a'], 2), 3);
  assert.equal(seekSequence(lines, ['a'], 4), -1);
  assert.equal(seekSequence(lines, ['a', 'b'], 0), 1);
  assert.equal(seekSequence(['x', 'a', 'b'], ['a', 'b'], 0, true), 1);
  assert.equal(seekSequence(['a', 'b', 'x', 'a', 'b'], ['a', 'b'], 0, true), 3, 'end of file is tried first');
  assert.equal(seekSequence(['a', 'b', 'x'], ['a', 'b'], 0, true), 0, 'otherwise it falls back to a normal search');
  assert.equal(seekSequence(['a'], ['a', 'b'], 0), -1);
  assert.equal(seekSequence(['\u201Cq\u201D \u2013 d\u2026'], ['"q" - d...'], 0), 0, 'typographic punctuation');
  assert.equal(seekSequence(['a\u00A0b'], ['a b'], 0), 0, 'no-break space');
});

test('applyChunks replaces lines and reports where', () => {
  const result = update('a\nb\nc\nd\n', ' a\n-b\n+B1\n+B2\n c');
  assert.equal(result.text, 'a\nB1\nB2\nc\nd\n');
  assert.deepEqual(result.changes, [{ line: 2, added: 2, removed: 1 }]);
  assert.deepEqual([result.added, result.removed], [2, 1]);
  assert.equal(update('a\nb\n', '-a\n-b').text, '');
  assert.equal(update('a\nb\n', '@@\n+top\n a').text, 'top\na\nb\n', 'an addition next to an unchanged line goes there');
  assert.equal(update('a\nb\nc\n', ' a\n+x\n+y\n b').text, 'a\nx\ny\nb\nc\n');
});

test("several hunks are applied in file order and may repeat each other's unchanged lines", () => {
  const file = 'one\ntwo\nthree\nfour\nfive\nsix\n';
  const result = update(file, '@@\n one\n-two\n+TWO\n three\n@@\n three\n four\n-five\n+FIVE\n six');
  assert.equal(result.text, 'one\nTWO\nthree\nfour\nFIVE\nsix\n');
  assert.deepEqual(
    result.changes.map((change) => change.line),
    [2, 5],
  );
  const adjacent = update('a\nb\nc\n', '-a\n+A\n b\n@@\n b\n-c\n+C');
  assert.equal(adjacent.text, 'A\nb\nC\n');
});

test('hunks that cannot be placed say why', () => {
  assert.throws(
    () => update('a\nb\n', ' x\n-y'),
    /Could not find the expected lines of change 1 in f\.txt:\n {2}x\n {2}y\nRead the file again/,
  );
  assert.throws(
    () => update('a\nb\nc\nd\n', '@@\n c\n-d\n+D\n@@\n a\n-b\n+B'),
    /change 2 in f\.txt:[\s\S]*same lines are at line 1, before the previous change/,
  );
  assert.throws(() => update('a\nb\n', '@@ nowhere\n-b'), /line 'nowhere' that follows '@@' \(change 1\) in f\.txt/);
  assert.throws(() => update('a\nb\nc\n', ' x\n-b\n*** End of File'), /change 1 in f\.txt \(expected at the end of the file\)/);
  const long = Array.from({ length: 20 }, (_, i) => ` missing ${i}`).join('\n');
  assert.throws(() => update('a\n', long), /missing 11\n {2}… and 8 more lines/);
  // Nothing before the failure leaks out: the function throws instead of returning partial text.
  assert.throws(() => update('a\nb\n', ' a\n-b\n+B\n@@\n-zzz'), /change 2/);
});

test('unchanged lines keep the file text even when the match was tolerant', () => {
  const file = '  \tif (x) {  \n    run();\n  }\n';
  const result = update(file, ' if (x) {\n-run();\n+go();\n }');
  assert.equal(result.text, '  \tif (x) {  \n' + 'go();\n' + '  }\n');
  const quoted = update('say \u201Chi\u201D\nold\n', ' say "hi"\n-old\n+new');
  assert.equal(quoted.text, 'say \u201Chi\u201D\nnew\n');
});

test('line endings: CRLF stays CRLF, added lines follow the dominant ending, a BOM is kept', () => {
  assert.equal(update('a\r\nb\r\nc\r\n', ' a\n-b\n+B1\n+B2\n c').text, 'a\r\nB1\r\nB2\r\nc\r\n');
  assert.equal(update('a\nb\r\nc\n', ' a\n-b\n+B\n c').text, 'a\nB\nc\n', 'mostly LF: added lines use LF');
  assert.equal(
    update('a\r\nb\r\nc\n', ' a\n-b\n+B').text,
    'a\r\nB\r\nc\n',
    'mostly CRLF: added lines use CRLF, the untouched LF line is left alone',
  );
  assert.equal(update('\uFEFFa\r\nb\r\n', ' a\n-b\n+B').text, '\uFEFFa\r\nB\r\n');
});

test('the final newline: kept when the last line is untouched, added when the patch changes the last line', () => {
  assert.equal(update('a\nb', ' a\n-b\n+B').text, 'a\nB\n');
  assert.equal(update('a\nb', '-a\n+A\n b').text, 'A\nb', 'a file without a final newline stays that way');
  assert.equal(update('a\nb', ' b\n+c').text, 'a\nb\nc\n', 'the old last line needs a line break once a line follows it');
  assert.equal(update('a\nb\n', ' b\n+c').text, 'a\nb\nc\n');
  assert.equal(update('a\nb\nc\n', ' b\n-c').text, 'a\nb\n');
});

test('a hunk with only added lines goes to the end of the file, before a final blank line', () => {
  assert.equal(update('a\nb\n', '+z').text, 'a\nb\nz\n');
  assert.equal(update('a\nb\n\n', '+z').text, 'a\nb\nz\n\n');
  assert.equal(update('', '+z').text, 'z\n');
  const result = update('a\nb\nc\n', '@@ a\n+z');
  assert.equal(result.text, 'a\nb\nc\nz\n');
  assert.match(result.notes[0], /Change 1 has only added lines, so it was appended at the end of f\.txt/);
  assert.deepEqual(result.changes, [{ line: 4, added: 1, removed: 0 }]);
  assert.deepEqual(update('a\nb\n', '+z').notes, [], 'no note when there was no "@@" line to mislead');
  const both = update('a\nb\nc\n', ' a\n-b\n+B\n@@\n+end');
  assert.equal(both.text, 'a\nB\nc\nend\n');
});

test('@@ lines narrow where a hunk is searched', () => {
  const file = 'fn one() {\n  x\n}\nfn two() {\n  x\n}\n';
  assert.equal(update(file, '@@ fn two() {\n-  x\n+  y').text, 'fn one() {\n  x\n}\nfn two() {\n  y\n}\n');
  assert.equal(update(file, '-  x\n+  y').text, 'fn one() {\n  y\n}\nfn two() {\n  x\n}\n', 'without it the first match wins');
  const chain = 'class A:\n  def m(self):\n    pass\nclass B:\n  def m(self):\n    pass\n';
  assert.equal(
    update(chain, '@@ class B:\n@@   def m(self):\n-    pass\n+    return 1').text,
    'class A:\n  def m(self):\n    pass\nclass B:\n  def m(self):\n    return 1\n',
  );
  assert.equal(
    update('def foo():\n    pass\n', '@@ def foo():\n def foo():\n-    pass\n+    return 1').text,
    'def foo():\n    return 1\n',
    'the @@ line repeated as the first unchanged line',
  );
});

test('*** End of File anchors a hunk to the end', () => {
  assert.equal(update('x\nfoo\ny\nfoo\n', '-foo\n+bar\n*** End of File').text, 'x\nfoo\ny\nbar\n');
  assert.equal(update('x\nfoo\ny\nfoo\n', '-foo\n+bar').text, 'x\nbar\ny\nfoo\n');
});

test('a blank unchanged line at the end of a hunk that the file does not have is ignored', () => {
  assert.equal(update('a\nb\nc\n', ' a\n-b\n+B\n c\n ').text, 'a\nB\nc\n');
  assert.equal(update('a\nb\nc\n', ' a\n-b\n+B\n c\n\n').text, 'a\nB\nc\n');
});

test('an update that changes nothing is reported as such', () => {
  const result = update('a\nb\n', ' a\n b');
  assert.equal(result.text, 'a\nb\n');
  assert.deepEqual([result.changes, result.added, result.removed], [[], 0, 0]);
});
