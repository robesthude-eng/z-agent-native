import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const canIsolate = typeof process.getuid === 'function' && process.getuid() === 0;
const describeExec = canIsolate ? test : test.skip;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-executor-test-'));
fs.chmodSync(temp, 0o755);
const workspaces = path.join(temp, 'workspaces');
const run = path.join(temp, 'run');
const workspace = path.join(workspaces, 'ses_executor1');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(run, { recursive: true });
fs.chmodSync(workspaces, 0o711);
fs.chmodSync(workspace, 0o700);
try { fs.chownSync(workspace, 20000, 20000); } catch {}
const socket = path.join(run, 'executor.sock');
process.env.Z_AGENT_EXECUTOR_SOCKET = socket;
process.env.Z_AGENT_EXECUTOR_REQUIRED = '1';
process.env.Z_AGENT_WORKSPACES_DIR = workspaces;
process.env.Z_AGENT_DATA_DIR = path.join(temp, 'data');

const child = spawn(process.execPath, [path.join(root, 'server/executor.mjs')], {
  env: { ...process.env, Z_AGENT_EXECUTOR_SOCKET: socket, Z_AGENT_WORKSPACES_DIR: workspaces },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childErr = '';
child.stderr.on('data', (chunk) => { childErr += chunk.toString('utf8'); });

async function waitSocket() {
  for (let i = 0; i < 100; i++) {
    try { if (fs.statSync(socket).isSocket()) return; } catch {}
    if (child.exitCode != null) throw new Error(`executor exited ${child.exitCode}: ${childErr}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`executor socket was not created: ${childErr}`);
}
await waitSocket();
const client = await import('../server/native/executor-client.mjs');
const store = await import('../server/native/store.mjs');
const turnResults = await import('../server/native/turn-results.mjs');

describeExec('executor IPC runs autonomous commands as the requested sandbox uid', async () => {
  const result = await client.executeInExecutor({
    workspace,
    uid: 20000,
    gid: 20000,
    file: '/bin/bash',
    args: ['--noprofile', '--norc', '-c', 'id -u; id -g; id -G; printf isolated > proof.txt'],
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: workspace },
    timeoutMs: 5000,
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), '20000\n20000\n20000');
  assert.equal(fs.readFileSync(path.join(workspace, 'proof.txt'), 'utf8'), 'isolated');
});

describeExec('executor never exposes privileged launcher to tool-controlled loader environment', async (t) => {
  const compiler = spawnSync('cc', ['--version'], { stdio: 'ignore' });
  if (compiler.status !== 0) return t.skip('C compiler unavailable for LD_PRELOAD regression probe');
  const source = path.join(workspace, 'preload-probe.c');
  const library = path.join(workspace, 'preload-probe.so');
  const privilegedProof = path.join(run, 'preload-root-proof');
  fs.writeFileSync(source, `#include <fcntl.h>\n#include <unistd.h>\n#include <stdio.h>\n__attribute__((constructor)) static void p(void){int f=open(${JSON.stringify(privilegedProof)},O_WRONLY|O_CREAT|O_APPEND,0600);if(f>=0){dprintf(f,"%d\\n",(int)geteuid());close(f);}}\n`);
  const built = spawnSync('cc', ['-shared', '-fPIC', source, '-o', library], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  try { fs.chownSync(library, 20000, 20000); } catch {}
  const result = await client.executeInExecutor({
    workspace, uid: 20000, gid: 20000, file: '/bin/true',
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: workspace, LD_PRELOAD: library }, timeoutMs: 5000,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(fs.existsSync(privilegedProof), false, 'LD_PRELOAD must not execute before uid/gid drop');
});

describeExec('executor rejects abusive environment keys before launch', async () => {
  await assert.rejects(() => client.executeInExecutor({
    workspace, uid: 20000, gid: 20000, file: '/bin/true', env: { 'BAD=KEY': 'x' }, timeoutMs: 5000,
  }), /Invalid environment key/);
});

describeExec('executor child cannot reconnect to the privileged executor Unix socket', async () => {
  const result = await client.executeInExecutor({
    workspace, uid: 20000, gid: 20000, file: process.execPath,
    args: ['-e', `const net=require('net');const s=net.connect(${JSON.stringify(socket)});s.on('connect',()=>process.exit(7));s.on('error',()=>process.exit(0));setTimeout(()=>process.exit(0),1000);`],
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: workspace }, timeoutMs: 5000,
  });
  assert.equal(result.code, 0);
});

describeExec('executor applies per-command process and file descriptor limits', async () => {
  const result = await client.executeInExecutor({
    workspace, uid: 20000, gid: 20000, file: '/bin/bash',
    args: ['--noprofile', '--norc', '-c', 'ulimit -u; ulimit -n; ulimit -c'],
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: workspace }, timeoutMs: 5000,
  });
  assert.equal(result.code, 0);
  const [nproc, nofile, core] = result.stdout.trim().split(/\s+/);
  assert.ok(Number(nproc) <= 256);
  assert.ok(Number(nofile) <= 2048);
  assert.equal(core, '0');
});

describeExec('turn snapshot git filters execute through the executor with the session identity', async () => {
  if (!store.getUser('executor@example.com')) store.createUser('executor@example.com', 'hash');
  if (!store.getChat('ses_executor1', 'executor@example.com')) store.createChat('ses_executor1', 'executor@example.com', 'Executor snapshot');
  const uid = store.getSandboxUid('ses_executor1');
  assert.equal(uid, 20000);
  const setup = await client.executeInExecutor({
    workspace, uid, gid: uid, file: '/bin/bash',
    args: ['--noprofile', '--norc', '-c', `git init -q && git config filter.probe.clean "sh -c 'id -G > filter-groups.txt; cat'" && printf '*.txt filter=probe\n' > .gitattributes && printf hello > tracked.txt`],
    env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: workspace }, timeoutMs: 5000,
  });
  assert.equal(setup.code, 0, setup.stderr);
  const tree = turnResults.captureWorkspaceTree(workspace);
  assert.match(tree, /^[0-9a-f]{40,64}$/);
  assert.equal(fs.readFileSync(path.join(workspace, 'filter-groups.txt'), 'utf8').trim(), '20000');
});

test('executor binds the requested uid/gid to the workspace owner', async () => {
  await assert.rejects(() => client.executeInExecutor({
    workspace,
    uid: 20001,
    gid: 20001,
    file: '/bin/true',
    timeoutMs: 5000,
  }), /ownership does not match executor identity/i);
});

test('executor rejects paths outside the shared workspace root', async () => {
  await assert.rejects(() => client.executeInExecutor({
    workspace: temp,
    uid: 20000,
    gid: 20000,
    file: '/bin/true',
    timeoutMs: 5000,
  }), /outside executor root/i);
});

test.after(async () => {
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
  fs.rmSync(temp, { recursive: true, force: true });
});
