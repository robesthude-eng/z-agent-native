import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('production env bootstrap creates strong keys, mode 0600, and refuses overwrite', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-env-init-'));
  const target = path.join(root, '.env');
  try {
    const first = spawnSync(process.execPath, ['scripts/init-production-env.mjs', target], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const stat = fs.statSync(target);
    assert.equal(stat.mode & 0o777, 0o600);
    const text = fs.readFileSync(target, 'utf8');
    assert.match(text, /^Z_AGENT_SECRET_KEY=[0-9a-f]{64}$/m);
    assert.match(text, /^Z_AGENT_AUDIT_KEY=[0-9a-f]{64}$/m);
    assert.match(text, /^Z_AGENT_METRICS_TOKEN=[A-Za-z0-9_-]{40,}$/m);
    assert.match(text, /^Z_AGENT_INVITE_CODE=[A-Za-z0-9_-]{32}$/m);
    assert.match(text, /^COMPOSE_FILE=docker-compose.yml:docker-compose.override.yml$/m);
    assert.match(text, /^Z_AGENT_ALLOW_SUDO=0$/m);
    assert.match(text, /^Z_AGENT_NETWORK_POLICY=off$/m);
    assert.match(text, /^Z_AGENT_SSH_POLICY=off$/m);
    assert.match(text, /^Z_AGENT_SENSITIVE_FILE_POLICY=block$/m);
    const second = spawnSync(process.execPath, ['scripts/init-production-env.mjs', target], { cwd: process.cwd(), encoding: 'utf8' });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /Refusing to overwrite/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('privileged single-user profiles require an explicit selection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-env-profile-'));
  try {
    for (const profile of ['trusted', 'unrestricted']) {
      const target = path.join(root, profile);
      const result = spawnSync(process.execPath, ['scripts/init-production-env.mjs', target, `--profile=${profile}`], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      const text = fs.readFileSync(target, 'utf8');
      assert.match(text, /^Z_AGENT_NETWORK_POLICY=public$/m);
      assert.match(text, /^Z_AGENT_SSH_POLICY=any$/m);
      assert.match(text, new RegExp(`^Z_AGENT_ALLOW_SUDO=${profile === 'unrestricted' ? '1' : '0'}$`, 'm'));
      assert.equal(/^COMPOSE_FILE=.*docker-compose.unrestricted.yml$/m.test(text), profile === 'unrestricted');
    }
    const bad = spawnSync(process.execPath, ['scripts/init-production-env.mjs', path.join(root, 'bad'), '--profile=typo'], { encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.equal(fs.existsSync(path.join(root, 'bad')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
