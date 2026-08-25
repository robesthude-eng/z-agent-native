import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';
process.env.Z_AGENT_NETWORK_POLICY = 'public';
process.env.Z_AGENT_ALLOW_NETWORKED_INSTALLERS = '1';
const {
  commitEnvironmentRequirement,
  managedShellEnvironment,
  prepareEnvironmentRequirement,
  readEnvironmentManifest,
} = await import('../server/native/environment.mjs');
const { TOOL_DEFINITIONS, availableToolDefinitions, requiresPermission } = await import('../server/native/tools.mjs');

function workspace(prefix = 'z-agent-env-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('environment tools are available with a shell sandbox and retain sensitive classification', () => {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'ensure_environment');
  assert.ok(definition);
  const kinds = definition.inputSchema.properties.kind.enum;
  for (const kind of ['python', 'java', 'gradle', 'android', 'go', 'rust', 'node', 'maven', 'flutter', 'kubectl', 'terraform', 'aws', 'gcloud', 'portable']) {
    assert.ok(kinds.includes(kind), `missing environment kind: ${kind}`);
  }
  assert.equal(requiresPermission('ensure_environment'), true);
  assert.ok(availableToolDefinitions().some((tool) => tool.name === 'ensure_environment'));
  assert.ok(availableToolDefinitions().some((tool) => tool.name === 'environment_status'));
});

test('Java plan installs a verified Temurin JDK below the hidden agent home', () => {
  const root = workspace();
  const plan = prepareEnvironmentRequirement(root, { kind: 'java', version: '21' });
  assert.equal(plan.kind, 'java');
  assert.ok(plan.env.JAVA_HOME.startsWith(path.join(root, '.agent-home')));
  assert.match(plan.script, /api\.adoptium\.net\/v3\/binary\/latest\/21\/ga\/linux/);
  assert.match(plan.script, /sha256sum -c/);
  assert.match(plan.script, /javac/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Android package provisioning requires explicit acceptLicenses input and pins the CLI checksum', () => {
  const root = workspace();
  assert.throws(
    () => prepareEnvironmentRequirement(root, { kind: 'android', packages: ['platforms;android-36'] }),
    /acceptLicenses=true/,
  );
  const plan = prepareEnvironmentRequirement(root, {
    kind: 'android',
    packages: ['platform-tools', 'platforms;android-36', 'build-tools;36.0.0'],
    acceptLicenses: true,
  });
  assert.match(plan.script, /commandlinetools-linux-15859902_latest\.zip/);
  assert.match(plan.script, /4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583/);
  assert.match(plan.script, /sdkmanager/);
  assert.equal(plan.env.ANDROID_HOME, plan.env.ANDROID_SDK_ROOT);
  fs.rmSync(root, { recursive: true, force: true });
});

test('managed environment persists only safe workspace-local variables and PATH entries', () => {
  const root = workspace();
  const plan = prepareEnvironmentRequirement(root, { kind: 'python', packages: ['paramiko'] });
  commitEnvironmentRequirement(root, plan);
  const manifest = readEnvironmentManifest(root);
  assert.equal(manifest.installed.python.packages[0], 'paramiko');
  assert.ok(manifest.env.VIRTUAL_ENV.startsWith(root));

  const manifestFile = path.join(root, '.agent-home', 'environment.json');
  const tampered = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  tampered.env.NODE_OPTIONS = '--require /tmp/evil.js';
  tampered.env.JAVA_HOME = '/tmp/escape';
  tampered.pathPrepend.unshift('/tmp/escape-bin');
  fs.writeFileSync(manifestFile, JSON.stringify(tampered));

  const env = managedShellEnvironment(root, { PATH: '/usr/bin', LANG: 'C.UTF-8' });
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.notEqual(env.JAVA_HOME, '/tmp/escape');
  assert.doesNotMatch(env.PATH, /^\/tmp\/escape-bin:/);
  assert.match(env.PATH, /\.agent-home\/venvs\/python\/bin/);
  assert.equal(env.USER, 'agent');
  fs.rmSync(root, { recursive: true, force: true });
});

test('package specs reject option injection while allowing normal version pins', () => {
  const root = workspace();
  assert.throws(() => prepareEnvironmentRequirement(root, { kind: 'python', packages: ['--index-url'] }), /Unsafe Python package spec/);
  const plan = prepareEnvironmentRequirement(root, { kind: 'python', packages: ['requests==2.32.5', 'paramiko'] });
  assert.match(plan.script, /requests==2\.32\.5/);
  fs.rmSync(root, { recursive: true, force: true });
});
