import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const script = fileURLToPath(new URL('../scripts/resolve-image-digest.mjs', import.meta.url));
const repo = 'ghcr.io/example/project/z-agent-api';
const digest = `sha256:${'a'.repeat(64)}`;
function resolve(values, repository = repo) {
  return spawnSync(process.execPath, [script, repository], { input: JSON.stringify(values), encoding: 'utf8' });
}
test('release digest selects the exact registry repository, not the first local alias', () => {
  const result = resolve([`z-agent-native@${digest}`, `${repo}@${digest}`]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), `${repo}@${digest}`);
});
test('release digest refuses an absent repository and lookalike prefixes', () => {
  for (const values of [[], [`z-agent-native@${digest}`], [`${repo}-other@${digest}`]]) {
    const result = resolve(values);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
});
test('release digest refuses malformed digests and ambiguous registry entries', () => {
  for (const values of [[`${repo}@sha256:short`], [`${repo}@${digest}`, `${repo}@sha256:${'b'.repeat(64)}`], null]) {
    const result = resolve(values);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
});
test('release digest allows a repeated identical entry but no tagged repository input', () => {
  assert.equal(resolve([`${repo}@${digest}`, `${repo}@${digest}`]).status, 0);
  assert.equal(resolve([`${repo}@${digest}`], `${repo}:latest`).status, 1);
});
