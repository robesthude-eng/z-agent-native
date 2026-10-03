import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { TOOL_DEFINITIONS } from '../server/native/tools/definitions.mjs';
import { buildSshArgs } from '../server/native/ssh-tool.mjs';
import { buildGitArgs } from '../server/native/git-tool.mjs';
import { buildTestCommand } from '../server/native/test-runner.mjs';
import { planDiagnostics } from '../server/native/diagnostics.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-contracts-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
function advertised(name, input) {
  const schema = TOOL_DEFINITIONS.find((tool) => tool.name === name).inputSchema;
  for (const key of Object.keys(input)) assert.ok(schema.properties[key], `${name}.${key} must be advertised`);
  return input;
}

test('SSH advertised fields and legacy aliases reach the Python CLI', () => {
  fs.writeFileSync(path.join(root, 'id_test'), 'test-key');
  for (const fields of [{ keyPath: 'id_test', remotePath: '/srv/app.py' }, { key: 'id_test', path: '/srv/app.py' }]) {
    const read = buildSshArgs(root, 'read', advertised('ssh_tool', { host: 'server', action: 'read', ...fields, offset: 3, limit: 7 }));
    assert.ok(read.args.includes(path.join(root, 'id_test')));
    assert.ok(read.args.includes('/srv/app.py'));
    assert.equal(read.args.at(-1), '7');
  }
  const patch = buildSshArgs(root, 'patch', advertised('ssh_tool', { host: 'server', action: 'patch', remotePath: '/srv/a', oldText: 'before', newText: 'after' }));
  assert.deepEqual(patch.args.slice(-4), ['--old', 'before', '--new', 'after']);
  for (const action of ['reload', 'journal', 'logs']) {
    const plan = buildSshArgs(root, 'service', advertised('ssh_tool', { host: 'server', action: 'service', service: 'nginx', serviceAction: action, lines: 17 }));
    assert.ok(plan.args.includes(action === 'journal' ? 'logs' : action));
    if (action !== 'reload') assert.deepEqual(plan.args.slice(-2), ['--lines', '17']);
  }
});

test('Git advertised count/ref aliases affect the requested history', () => {
  const plan = buildGitArgs(root, 'log', advertised('git', { action: 'log', count: 3, ref: 'HEAD~2' }));
  assert.ok(plan.args.includes('--max-count=3'));
  assert.ok(plan.args.includes('HEAD~2'));
});

test('diagnostics kinds selects only the requested check', () => {
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', lint: 'eslint .' } }));
  assert.deepEqual(planDiagnostics(root, advertised('diagnostics', { kinds: ['lint'] })).map((p) => p.kind), ['lint']);
  assert.deepEqual(planDiagnostics(root, { kinds: ['typecheck'] }).map((p) => p.kind), ['typecheck']);
  assert.equal(planDiagnostics(root, { kinds: ['lint', 'typecheck'] }).length, 2);
  assert.throws(() => planDiagnostics(root, { kinds: ['invalid'] }), /Unsupported/);
});

test('explicit test framework wins over project detection and filter stays one literal argument', () => {
  assert.equal(buildTestCommand(root, advertised('run_tests', { framework: 'pytest' })).command, 'pytest -q');
  const filter = "a b'; touch INJECTED; echo '$(id)`id`";
  const plan = buildTestCommand(root, advertised('run_tests', { command: "printf '%s'", filter }));
  const result = spawnSync('/bin/sh', ['-c', plan.command], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, filter);
  assert.equal(fs.existsSync(path.join(root, 'INJECTED')), false);
});
