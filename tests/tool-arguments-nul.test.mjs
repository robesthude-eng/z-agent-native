import assert from 'node:assert/strict';
import test from 'node:test';
import { parseToolArguments, stripNulChars } from '../server/native/providers/streaming.mjs';

test('NUL characters are removed from nested tool arguments', () => {
  const parsed = parseToolArguments('{"command":"seq 1 9 | tail\\u0000 -n 3\\u0000","opts":{"cwd":"a\\u0000b"},"list":["x\\u0000"]}');
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.command, 'seq 1 9 | tail -n 3');
  assert.equal(parsed.value.opts.cwd, 'ab');
  assert.deepEqual(parsed.value.list, ['x']);
});

test('object arguments are cleaned too and clean values are untouched', () => {
  assert.deepEqual(parseToolArguments({ command: 'ls\u0000' }).value, { command: 'ls' });
  assert.deepEqual(parseToolArguments('{"n":1,"ok":true,"s":"é"}').value, { n: 1, ok: true, s: 'é' });
  assert.equal(stripNulChars(null), null);
  assert.equal(stripNulChars(5), 5);
});
