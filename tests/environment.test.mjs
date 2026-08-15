import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';
const {
  commitEnvironmentRequirement,
  managedShellEnvironment,
  prepareEnvironmentRequirement,
  readEnvironmentManifest,
} = await import('../server/native/environment.mjs');
const {
  EXTENDED_TOOLCHAIN_KINDS,
  prepareToolchainRequirement,
  suggestToolchainForCommand,
} = await import('../server/native/toolchains.mjs');
const { TOOL_DEFINITIONS, availableToolDefinitions, requiresPermission } = await import('../server/native/tools.mjs');

function workspace(prefix = 'z-agent-env-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('environment tool is permission-gated and exposes the universal toolchain catalog', () => {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'ensure_environment');
  assert.ok(definition);
  assert.deepEqual(definition.inputSchema.properties.kind.enum, [
    'python', 'java', 'gradle', 'android',
    ...EXTENDED_TOOLCHAIN_KINDS,
  ]);
  assert.equal(requiresPermission('ensure_environment'), true);
  assert.ok(availableToolDefinitions().some((tool) => tool.name === 'ensure_environment'));
  assert.ok(TOOL_DEFINITIONS.some((tool) => tool.name === 'environment_status'));
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

test('Android package provisioning requires explicit license acceptance and pins the CLI checksum', () => {
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

test('Go, Rust, Node, Maven, kubectl and Terraform plans use official downloads with integrity checks', () => {
  const root = workspace();
  const go = prepareToolchainRequirement(root, { kind: 'go', version: 'latest' });
  assert.match(go.script, /go\.dev\/dl\/\?mode=json/);
  assert.match(go.script, /sha256sum -c/);

  const rust = prepareToolchainRequirement(root, { kind: 'rust', version: 'stable' });
  assert.match(rust.script, /static\.rust-lang\.org\/rustup\/dist/);
  assert.match(rust.script, /\.sha256/);

  const node = prepareToolchainRequirement(root, { kind: 'node', version: 'lts' });
  assert.match(node.script, /nodejs\.org\/dist\/index\.json/);
  assert.match(node.script, /SHASUMS256\.txt/);

  const maven = prepareToolchainRequirement(root, { kind: 'maven', version: 'latest' });
  assert.match(maven.script, /apache-maven/);
  assert.match(maven.script, /sha512sum -c/);

  const kubectl = prepareToolchainRequirement(root, { kind: 'kubectl', version: 'stable' });
  assert.match(kubectl.script, /dl\.k8s\.io\/release\/stable\.txt/);
  assert.match(kubectl.script, /kubectl\.sha256/);

  const terraform = prepareToolchainRequirement(root, { kind: 'terraform', version: 'latest' });
  assert.match(terraform.script, /checkpoint-api\.hashicorp\.com/);
  assert.match(terraform.script, /SHA256SUMS/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('Flutter plan resolves the official Linux SDK archive and verifies SHA-256 on x64', { skip: process.arch !== 'x64' }, () => {
  const root = workspace();
  const flutter = prepareToolchainRequirement(root, { kind: 'flutter', version: 'stable' });
  assert.match(flutter.script, /flutter_infra_release\/releases\/releases_linux\.json/);
  assert.match(flutter.script, /sha256sum -c/);
  assert.match(flutter.script, /flutter.*--version/s);
  fs.rmSync(root, { recursive: true, force: true });
});

test('portable provisioning requires HTTPS, a pinned SHA-256 and safe archive paths', () => {
  const root = workspace();
  assert.throws(() => prepareToolchainRequirement(root, {
    kind: 'portable', name: 'tool', url: 'http://example.com/tool', sha256: 'a'.repeat(64),
  }), /HTTPS/);
  assert.throws(() => prepareToolchainRequirement(root, {
    kind: 'portable', name: 'tool', url: 'https://example.com/tool', sha256: 'nope',
  }), /sha256/);
  assert.throws(() => prepareToolchainRequirement(root, {
    kind: 'portable', name: 'tool', url: 'https://example.com/tool.zip', sha256: 'a'.repeat(64), archiveType: 'zip', binaryPath: '../tool',
  }), /Unsafe portable binaryPath/);
  const plan = prepareToolchainRequirement(root, {
    kind: 'portable', name: 'tool', version: '1.2.3', url: 'https://example.com/tool.zip', sha256: 'a'.repeat(64), archiveType: 'zip', binaryPath: 'release/tool',
  });
  assert.match(plan.script, /sha256sum -c/);
  assert.match(plan.script, /release\/tool/);
  assert.ok(plan.pathPrepend[0].startsWith(path.join(root, '.agent-home')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('missing-command hints map common build CLIs to provisioner kinds', () => {
  assert.deepEqual(suggestToolchainForCommand('cargo'), { command: 'cargo', kind: 'rust' });
  assert.deepEqual(suggestToolchainForCommand('mvn'), { command: 'mvn', kind: 'maven' });
  assert.deepEqual(suggestToolchainForCommand('terraform'), { command: 'terraform', kind: 'terraform' });
  assert.deepEqual(suggestToolchainForCommand('adb'), { command: 'adb', kind: 'android' });
  assert.equal(suggestToolchainForCommand('totally-custom-cli'), null);
});
