import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-sandbox-data-'));
const workspaces = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-sandbox-workspaces-'));
process.env.Z_AGENT_DATA_DIR = data;
process.env.Z_AGENT_WORKSPACES_DIR = workspaces;
delete process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL;

const store = await import('../server/native/store.mjs');
const sandbox = await import('../server/native/sandbox.mjs');
const { executeTool } = await import('../server/native/tools.mjs');

const secureSandboxAvailable = sandbox.shellSandboxAvailable();

test('each native chat gets a stable distinct sandbox Unix identity', () => {
  store.createUser('sandbox@example.com', 'hash');
  store.createChat('ses_sandboxa1', 'sandbox@example.com', 'A');
  store.createChat('ses_sandboxb1', 'sandbox@example.com', 'B');
  const a = store.getSandboxUid('ses_sandboxa1');
  const b = store.getSandboxUid('ses_sandboxb1');
  assert.ok(Number.isInteger(a));
  assert.ok(Number.isInteger(b));
  assert.notEqual(a, b);
  assert.equal(store.getSandboxUid('ses_sandboxa1'), a);
});

test('sandbox Unix identities are never reused after chat deletion', () => {
  store.createChat('ses_sandboxd1', 'sandbox@example.com', 'D');
  const oldUid = store.getSandboxUid('ses_sandboxd1');
  assert.equal(store.deleteChat('ses_sandboxd1', 'sandbox@example.com'), true);
  store.createChat('ses_sandboxe1', 'sandbox@example.com', 'E');
  assert.ok(store.getSandboxUid('ses_sandboxe1') > oldUid);
});

test('isolated shell cannot read runtime secrets or another session workspace', { skip: !secureSandboxAvailable }, async () => {
  store.setProviderKey('sandbox@example.com', 'openai', 'super-secret-provider-key');
  const aRoot = store.workspaceFor('ses_sandboxa1');
  const bRoot = store.workspaceFor('ses_sandboxb1');
  fs.writeFileSync(path.join(aRoot, 'mine.txt'), 'mine');
  fs.writeFileSync(path.join(bRoot, 'other-secret.txt'), 'other-session-secret');
  sandbox.prepareWorkspaceSandbox('ses_sandboxb1', bRoot);

  const uidA = store.getSandboxUid('ses_sandboxa1');
  const command = [
    'printf "uid=%s\\n" "$(id -u)"',
    'printf "mine="; cat mine.txt',
    `printf "\\nother="; cat ${JSON.stringify(path.join(bRoot, 'other-secret.txt'))} 2>/dev/null || printf DENIED`,
    `printf "\\nmaster="; cat ${JSON.stringify(path.join(data, 'master.key'))} 2>/dev/null || printf DENIED`,
    `printf "\\ndb="; if test -r ${JSON.stringify(path.join(data, 'z-agent.sqlite'))}; then printf READABLE; else printf DENIED; fi`,
  ].join('; ');
  const result = await executeTool('bash', { command }, { sessionId: 'ses_sandboxa1', workspace: aRoot, signal: new AbortController().signal });
  assert.equal(result.metadata.exit, 0);
  assert.match(result.output, new RegExp(`uid=${uidA}`));
  assert.match(result.output, /mine=mine/);
  assert.match(result.output, /other=DENIED/);
  assert.match(result.output, /master=DENIED/);
  assert.match(result.output, /db=DENIED/);
  assert.doesNotMatch(result.output, /super-secret-provider-key/);
});

test('managed home creates session-writable cache and venv directories', () => {
  store.createChat('ses_sandboxh1', 'sandbox@example.com', 'H');
  const root = store.workspaceFor('ses_sandboxh1');
  fs.mkdirSync(root, { recursive: true });
  // Simulate the API mkdir'ing HOME as the server user before the session shell runs.
  fs.mkdirSync(path.join(root, '.agent-home'), { recursive: true });
  const home = sandbox.ensureManagedHome('ses_sandboxh1', root);
  assert.equal(home, path.join(root, '.agent-home'));
  assert.equal(fs.statSync(path.join(home, 'venvs')).isDirectory(), true);
  assert.equal(fs.statSync(path.join(home, 'cache', 'pip')).isDirectory(), true);
  assert.equal(fs.statSync(path.join(home, 'cache', 'npm')).isDirectory(), true);
});

test('session uid can mkdir venvs after the API created .agent-home', { skip: !secureSandboxAvailable }, async () => {
  const aRoot = store.workspaceFor('ses_sandboxa1');
  fs.mkdirSync(path.join(aRoot, '.agent-home'), { recursive: true });
  sandbox.ensureManagedHome('ses_sandboxa1', aRoot);
  const result = await executeTool('bash', {
    command: 'mkdir -p "$HOME/venvs/python" "$HOME/cache/pip" && test -w "$HOME/venvs" && test -w "$HOME/cache/pip" && echo writable',
  }, { sessionId: 'ses_sandboxa1', workspace: aRoot, signal: new AbortController().signal });
  assert.equal(result.metadata.exit, 0);
  assert.match(result.output, /writable/);
});

test('secure mode refuses shell when UID isolation is unavailable unless unsafe fallback is explicit', { skip: secureSandboxAvailable }, () => {
  assert.equal(sandbox.shellSandboxAvailable(), false);
  assert.throws(() => sandbox.sandboxIdentity('ses_sandboxa1'), /sandbox is unavailable/i);
});

test.after(() => {
  store.closeStore();
  fs.rmSync(data, { recursive: true, force: true });
  fs.rmSync(workspaces, { recursive: true, force: true });
});
