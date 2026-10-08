import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';

function run(args) {
  return spawnSync(process.execPath, ['server/restore-verify.mjs', ...args], {
    cwd: path.resolve('.'),
    encoding: 'utf8',
    env: { ...process.env, Z_AGENT_AUDIT_KEY: Buffer.alloc(32, 7).toString('base64') },
  });
}

function lastJsonLine(text) {
  return JSON.parse(
    String(text)
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.startsWith('{'))
      .at(-1),
  );
}

test('restore-verify reports failures as one JSON line, exit 1, no stack trace', () => {
  const usage = run([]);
  assert.equal(usage.status, 1);
  assert.deepEqual(Object.keys(lastJsonLine(usage.stderr)), ['ok', 'error']);
  assert.equal(lastJsonLine(usage.stderr).ok, false);
  assert.match(lastJsonLine(usage.stderr).error, /Usage/);
  assert.doesNotMatch(usage.stderr, /\n\s+at /);

  const missing = run(['/nonexistent/snapshot.sqlite']);
  assert.equal(missing.status, 1);
  assert.match(lastJsonLine(missing.stderr).error, /ENOENT/);
  assert.doesNotMatch(missing.stderr, /\n\s+at /);
});
