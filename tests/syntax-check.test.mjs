import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeTool } from '../server/native/tools.mjs';
import { checkSyntax } from '../server/native/tools/syntax-check.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sc-'));
const put = (root, name, text) => fs.writeFileSync(path.join(root, name), text);

test('valid files report nothing', async () => {
  const root = tmp();
  put(root, 'a.mjs', 'export const a = 1;\n');
  put(root, 'a.json', '{"a":1}');
  assert.equal(await checkSyntax(root, 'a.mjs'), '');
  assert.equal(await checkSyntax(root, 'a.json'), '');
  assert.equal(await checkSyntax(root, 'README.md'), '');
});

test('broken JS and JSON are reported without the absolute path', async () => {
  const root = tmp();
  put(root, 'b.js', 'function f( {\n');
  put(root, 'b.json', '{"a":');
  const js = await checkSyntax(root, 'b.js');
  assert.match(js, /b\.js: syntax error/);
  assert.match(js, /SyntaxError/);
  assert.ok(!js.includes(root));
  assert.match(await checkSyntax(root, 'b.json'), /invalid JSON/);
});

test('python syntax errors are reported when python3 is available', async (t) => {
  const root = tmp();
  put(root, 'c.py', 'def f(:\n  pass\n');
  const out = await checkSyntax(root, 'c.py');
  if (!out) return t.skip('python3 not available');
  assert.match(out, /SyntaxError/);
});

test('edit/write append the warning, and it can be turned off', async () => {
  const root = tmp();
  const written = await executeTool('write', { path: 'x.mjs', content: 'const = ;\n' }, { workspace: root, sessionId: null });
  assert.match(written.output, /Syntax check failed/);
  assert.equal(written.metadata.syntaxError, true);
  const ok = await executeTool('write', { path: 'y.mjs', content: 'const y = 1;\n' }, { workspace: root, sessionId: null });
  assert.doesNotMatch(ok.output, /Syntax check/);
  process.env.Z_AGENT_SYNTAX_CHECK = '0';
  try {
    assert.equal(await checkSyntax(root, 'x.mjs'), '');
  } finally {
    delete process.env.Z_AGENT_SYNTAX_CHECK;
  }
});
