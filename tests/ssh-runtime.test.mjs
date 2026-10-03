import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { executeSshTool } from '../server/native/ssh-tool.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-runtime-'));
const oldPath = process.env.PATH;
process.env.Z_AGENT_SSH_POLICY = 'any';
process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';
test.after(() => { process.env.PATH = oldPath; fs.rmSync(root, { recursive: true, force: true }); });

test('Python SSH contracts: sudo, services and atomic replacement', () => {
  const result = spawnSync('python3', ['-B', 'tests/ssh-cli-checks.py'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('failed remote reads are errors, not successful tool results', async () => {
  const launcher = path.join(root, 'python3');
  fs.writeFileSync(launcher, '#!/bin/sh\necho "remote permission denied" >&2\nexit 7\n', { mode: 0o700 });
  process.env.PATH = `${root}:${oldPath}`;
  try {
    await assert.rejects(() => executeSshTool({ root, identity: { isolated: false }, input: { action: 'read', host: 'unused.test', path: '/app' } }), /remote permission denied/);
  } finally { process.env.PATH = oldPath; }
});

test('cancellation kills an SSH process even when it ignores SIGTERM', async () => {
  const launcher = path.join(root, 'python3');
  fs.writeFileSync(launcher, '#!/usr/bin/env node\nprocess.on("SIGTERM", () => {}); console.log("READY"); setInterval(() => {}, 1000);\n', { mode: 0o700 });
  process.env.PATH = `${root}:${oldPath}`;
  const controller = new AbortController();
  try {
    await assert.rejects(() => executeSshTool({ root, identity: { isolated: false }, input: { action: 'exec', host: 'unused.test', command: 'unused' }, signal: controller.signal, onOutput: (out) => { if (out.includes('READY')) controller.abort(); } }), { name: 'AbortError' });
  } finally { process.env.PATH = oldPath; }
});
