import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isPinnedCommit, resolveLocalBenchmarkSource, validateBenchmarkManifest } from '../scripts/repo-benchmark-manifest.mjs';

const good = {
  version: 1,
  cases: [{
    id: 'real-fix-1',
    source: { type: 'git', url: 'https://github.com/example/project.git', ref: 'a'.repeat(40) },
    prompt: 'Fix the documented regression without changing the public API.',
    verifyCommand: 'npm test',
    regressionCommands: ['npm run typecheck'],
    maxToolCalls: 80,
    maxDurationMs: 600000,
  }],
};

test('production benchmark manifest requires immutable commits and executable oracle checks', () => {
  assert.deepEqual(validateBenchmarkManifest(structuredClone(good)), good);
  assert.equal(isPinnedCommit('b'.repeat(40)), true);
  assert.equal(isPinnedCommit('release/main'), false);
  const branch = structuredClone(good); branch.cases[0].source.ref = 'main';
  assert.throws(() => validateBenchmarkManifest(branch), /full 40\/64-character commit hash/);
  const noOracle = structuredClone(good); noOracle.cases[0].verifyCommand = '';
  assert.throws(() => validateBenchmarkManifest(noOracle), /requires verifyCommand/);
  const credentials = structuredClone(good); credentials.cases[0].source.url = 'https://user:secret@example.com/repo.git';
  assert.throws(() => validateBenchmarkManifest(credentials), /credential-free HTTPS/);
});

test('local benchmark sources are confined to the configured corpus root', () => {
  const root = path.resolve('/tmp/benchmark-corpus');
  assert.equal(resolveLocalBenchmarkSource(root, 'repo-a'), path.join(root, 'repo-a'));
  assert.throws(() => resolveLocalBenchmarkSource(root, '../secret'), /escapes/);
});
