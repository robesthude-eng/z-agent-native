import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CLOUD_TOOLCHAIN_KINDS, prepareCloudToolchainRequirement } from '../server/native/cloud-toolchains.mjs';
import { EXTENDED_TOOLCHAIN_KINDS, prepareToolchainRequirement, suggestToolchainForCommand } from '../server/native/toolchains.mjs';

/**
 * These provisioners build shell scripts that download and execute third-party
 * toolchains. A quoting or validation mistake here is remote code execution, so
 * the contract is asserted directly on the generated plan instead of only being
 * documented in docs/TOOLCHAINS.md.
 *
 * Nothing in this file touches the network: only plan construction is exercised.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-toolchain-'));
const archSupported = process.arch === 'x64' || process.arch === 'arm64';

/** Minimal valid input per exported kind. Defaults are used where the plan allows them. */
const VALID_INPUT = {
  go: {},
  rust: {},
  node: {},
  maven: {},
  flutter: {},
  kubectl: {},
  terraform: {},
  aws: {},
  gcloud: {},
  portable: {
    name: 'shellcheck',
    url: 'https://example.invalid/shellcheck.tar.xz',
    sha256: 'a'.repeat(64),
    archiveType: 'tar.xz',
    binaryPath: 'shellcheck-v0.10.0/shellcheck',
    version: '0.10.0',
  },
};

function planFor(kind) {
  return prepareToolchainRequirement(root, { kind, ...VALID_INPUT[kind] });
}

function bashSyntaxError(script) {
  const result = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  if (result.error) return null; // bash unavailable: skip rather than fail the suite
  return result.status === 0 ? null : result.stderr.trim();
}

test('every advertised toolchain kind has a plan builder and vice versa', () => {
  assert.deepEqual(
    [...EXTENDED_TOOLCHAIN_KINDS].sort(),
    Object.keys(VALID_INPUT).sort(),
    'EXTENDED_TOOLCHAIN_KINDS and the tested kinds drifted apart; a kind advertised to the model without a plan builder throws at tool call time',
  );
  for (const kind of CLOUD_TOOLCHAIN_KINDS) {
    assert.ok(EXTENDED_TOOLCHAIN_KINDS.includes(kind), `cloud kind ${kind} must stay reachable through prepareToolchainRequirement`);
  }
});

test('unsupported kinds are rejected instead of falling through', () => {
  assert.throws(() => prepareToolchainRequirement(root, { kind: '' }), /Unsupported extended toolchain kind: \(empty\)/);
  assert.throws(() => prepareToolchainRequirement(root, { kind: 'brew' }), /Unsupported extended toolchain kind: brew/);
  assert.throws(() => prepareToolchainRequirement(root, {}), /Unsupported extended toolchain kind/);
  assert.throws(() => prepareCloudToolchainRequirement(root, { kind: 'azure' }), /Unsupported cloud toolchain kind: azure/);
});

test('every plan is well formed and stays inside the session agent home', (t) => {
  if (!archSupported) return t.skip(`unsupported test arch ${process.arch}`);
  const agentHome = path.join(root, '.agent-home');
  const seenKeys = new Set();

  for (const kind of EXTENDED_TOOLCHAIN_KINDS) {
    const plan = planFor(kind);
    assert.equal(plan.kind, kind, `${kind}: plan.kind must match the requested kind`);
    assert.ok(plan.title && typeof plan.title === 'string', `${kind}: needs a human readable title for the permission gate`);
    assert.ok(typeof plan.script === 'string' && plan.script.length > 0, `${kind}: needs a script`);
    assert.deepEqual(plan.env, {}, `${kind}: plans must not inject environment variables implicitly`);

    assert.ok(Array.isArray(plan.pathPrepend) && plan.pathPrepend.length > 0, `${kind}: must expose at least one PATH entry`);
    for (const entry of plan.pathPrepend) {
      assert.ok(path.isAbsolute(entry), `${kind}: PATH entry must be absolute: ${entry}`);
      assert.ok(
        entry === agentHome || entry.startsWith(`${agentHome}${path.sep}`),
        `${kind}: PATH entry escapes the session agent home: ${entry}`,
      );
    }

    assert.ok(plan.installedKey && !seenKeys.has(plan.installedKey), `${kind}: installedKey must be unique (${plan.installedKey})`);
    seenKeys.add(plan.installedKey);
    assert.equal(plan.installedValue?.kind, kind, `${kind}: installedValue.kind must round-trip`);
  }
});

test('generated scripts are strict-mode bash and syntactically valid', (t) => {
  if (!archSupported) return t.skip(`unsupported test arch ${process.arch}`);
  for (const kind of EXTENDED_TOOLCHAIN_KINDS) {
    const { script } = planFor(kind);
    assert.ok(script.startsWith('set -euo pipefail\n'), `${kind}: script must fail fast on the first error`);
    const syntax = bashSyntaxError(script);
    assert.equal(syntax, null, `${kind}: generated script is not valid bash:\n${syntax}`);
  }
});

test('every download is HTTPS and every artifact is integrity checked', (t) => {
  if (!archSupported) return t.skip(`unsupported test arch ${process.arch}`);
  for (const kind of EXTENDED_TOOLCHAIN_KINDS) {
    const { script } = planFor(kind);

    for (const match of script.matchAll(/https?:\/\/[^\s'"]+/g)) {
      assert.ok(match[0].startsWith('https://'), `${kind}: plain HTTP download would allow a downgrade: ${match[0]}`);
    }

    // Apache publishes .sha512 sidecars, so maven verifies with sha512sum, and
    // the AWS CLI ships a detached PGP signature instead of a digest.
    const verified =
      script.includes('sha256sum -c -') ||
      script.includes('sha512sum -c -') ||
      script.includes('gpg --batch --verify');
    assert.ok(verified, `${kind}: downloaded artifact is executed without a checksum or signature check`);

    assert.ok(!/\bsudo\b/.test(script), `${kind}: provisioning must never escalate privileges`);
    assert.ok(!/\bapt-get\b|\bdnf\b|\byum\b/.test(script), `${kind}: provisioning must not touch system package managers`);
    assert.ok(!script.includes('curl -fsSL https://sh.'), `${kind}: piping a remote installer into a shell is not an integrity model`);
    assert.ok(!/\|\s*(?:ba)?sh\b/.test(script), `${kind}: no downloaded stream may be piped into a shell`);
  }
});

test('version input is validated before it reaches the shell', (t) => {
  if (!archSupported) return t.skip(`unsupported test arch ${process.arch}`);
  const injections = [
    'latest; id',
    'latest && id',
    'latest | id',
    '$(id)',
    '`id`',
    "1.0'; id; '",
    '../../etc/passwd',
    'a'.repeat(200),
  ];
  for (const kind of ['go', 'rust', 'node', 'terraform']) {
    for (const version of injections) {
      assert.throws(
        () => prepareToolchainRequirement(root, { kind, version }),
        /Invalid .* version:/,
        `${kind}: version ${JSON.stringify(version)} must be rejected, not quoted and hoped for`,
      );
    }
  }
});

test('surrounding whitespace is normalized rather than rejected', (t) => {
  if (!archSupported) return t.skip(`unsupported test arch ${process.arch}`);
  // safeVersion() trims its input, so a padded value is accepted rather than
  // rejected. Pinned here so a future tightening of the validator shows up as a
  // failing test instead of breaking callers that pass through user input.
  const plan = prepareToolchainRequirement(root, { kind: 'go', version: '  1.24.2  ' });
  assert.ok(plan.script.includes('1.24.2'), 'the trimmed version must reach the download URL');
  assert.ok(!/\s\s1\.24\.2/.test(plan.script), 'untrimmed input must not leak into the script');
});

test('accepted versions stay on the documented allowlist', (t) => {
  if (!archSupported) return t.skip(`unsupported test arch ${process.arch}`);
  assert.equal(prepareToolchainRequirement(root, { kind: 'go', version: '1.24.2' }).installedKey, 'go:1.24.2');
  assert.equal(prepareToolchainRequirement(root, { kind: 'rust', version: 'nightly' }).installedKey, 'rust:nightly');
  assert.equal(prepareToolchainRequirement(root, { kind: 'node', version: '24.4.1' }).installedKey, 'node:24.4.1');
  assert.equal(prepareToolchainRequirement(root, { kind: 'terraform', version: '1.9.8' }).installedKey, 'terraform:1.9.8');
  assert.throws(() => prepareToolchainRequirement(root, { kind: 'node', version: '24' }), /Invalid Node\.js version/);
  assert.throws(() => prepareToolchainRequirement(root, { kind: 'rust', version: 'dev' }), /Invalid Rust version/);
});

test('portable mode refuses anything but a pinned HTTPS artifact', () => {
  const base = VALID_INPUT.portable;
  const reject = (patch, expected) => assert.throws(() => prepareToolchainRequirement(root, { kind: 'portable', ...base, ...patch }), expected);

  reject({ url: 'http://example.invalid/tool' }, /Portable URL must be an HTTPS URL/);
  reject({ url: 'file:///etc/passwd' }, /Portable URL must be an HTTPS URL/);
  reject({ url: `https://example.invalid/${'a'.repeat(2100)}` }, /Portable URL must be an HTTPS URL/);
  reject({ sha256: '' }, /Portable sha256 must be exactly 64 hexadecimal characters/);
  reject({ sha256: 'z'.repeat(64) }, /Portable sha256 must be exactly 64 hexadecimal characters/);
  reject({ sha256: 'a'.repeat(63) }, /Portable sha256 must be exactly 64 hexadecimal characters/);
  reject({ archiveType: 'tar.bz2' }, /Portable archiveType must be raw, zip, tar\.gz, or tar\.xz/);
  reject({ name: 'bin/tool' }, /Portable name must be a single command name/);
  reject({ name: '../tool' }, /Unsafe portable name|Portable name must be a single command name/);
  reject({ name: '' }, /Unsafe portable name/);
  reject({ name: 'to ol' }, /Unsafe portable name/);
  reject({ binaryPath: '/etc/passwd' }, /Unsafe portable binaryPath/);
  reject({ binaryPath: '../../etc/passwd' }, /Unsafe portable binaryPath/);
  reject({ binaryPath: 'nested/../../escape' }, /Unsafe portable binaryPath/);
  reject({ binaryPath: '' }, /Unsafe portable binaryPath/);
});

test('portable raw mode does not require a binaryPath and pins the supplied digest', () => {
  const plan = prepareToolchainRequirement(root, {
    kind: 'portable',
    name: 'mytool',
    url: 'https://example.invalid/mytool',
    sha256: 'b'.repeat(64),
    archiveType: 'raw',
  });
  assert.equal(plan.installedKey, 'portable:mytool:custom');
  assert.equal(plan.installedValue.sha256, 'b'.repeat(64));
  assert.ok(plan.script.includes('sha256sum -c -'), 'raw portable install must still verify the digest');
  assert.ok(plan.script.includes(`'${'b'.repeat(64)}'`), 'the pinned digest must be passed as a quoted literal');
});

test('shell metacharacters inside an accepted URL cannot break out of the curl argument', () => {
  const plan = prepareToolchainRequirement(root, {
    kind: 'portable',
    name: 'probe',
    url: "https://example.invalid/a'$(id)'b",
    sha256: 'c'.repeat(64),
    archiveType: 'raw',
  });

  const syntax = bashSyntaxError(plan.script);
  assert.equal(syntax, null, `a quoted URL must not corrupt the script:\n${syntax}`);
  // The single quote is closed and reopened via '"'"' so $(id) stays literal text.
  assert.ok(plan.script.includes(`'"'"'`), 'single quotes in the URL must be escaped, not stripped');
  assert.ok(!/[^'\\]\$\(id\)/.test(plan.script), 'command substitution must never appear outside single quotes');
});

test('cloud provisioners only accept the versions they can actually verify', (t) => {
  if (!archSupported) return t.skip(`unsupported test arch ${process.arch}`);
  assert.throws(() => prepareToolchainRequirement(root, { kind: 'aws', version: '2.15.0' }), /supports version=latest only/);
  assert.throws(() => prepareToolchainRequirement(root, { kind: 'gcloud', version: '470.0.0' }), /supports version=latest only/);
  assert.throws(() => prepareToolchainRequirement(root, { kind: 'gcloud', sha256: 'nope' }), /sha256 must be 64 hexadecimal characters/);

  const aws = prepareToolchainRequirement(root, { kind: 'aws' });
  assert.equal(aws.installedValue.verification, 'PGP');
  assert.match(aws.installedValue.fingerprint, /^[0-9A-F]{40}$/, 'the AWS signer fingerprint must be pinned in source');
  assert.ok(aws.script.includes('gpg --batch --verify'), 'the AWS installer must be signature verified');
  assert.ok(aws.script.includes(aws.installedValue.fingerprint), 'the script must compare against the pinned fingerprint');

  const pinned = prepareToolchainRequirement(root, { kind: 'gcloud', sha256: 'D'.repeat(64) });
  assert.equal(pinned.installedValue.verification, 'supplied SHA-256');
  assert.ok(pinned.script.includes(`'${'d'.repeat(64)}'`), 'a supplied digest must be normalized to lowercase and quoted');

  const resolved = prepareToolchainRequirement(root, { kind: 'gcloud' });
  assert.match(resolved.installedValue.verification, /resolved from official Google Cloud download page/);
});

test('command hints map missing binaries to a provisioner that exists', () => {
  assert.deepEqual(suggestToolchainForCommand('cargo'), { command: 'cargo', kind: 'rust' });
  assert.deepEqual(suggestToolchainForCommand('  MVN '), { command: 'mvn', kind: 'maven' });
  assert.equal(suggestToolchainForCommand('definitely-not-a-tool'), null);
  assert.equal(suggestToolchainForCommand(''), null);
  assert.equal(suggestToolchainForCommand(undefined), null);

  const provisionable = new Set([...EXTENDED_TOOLCHAIN_KINDS, 'java', 'gradle', 'python', 'android']);
  for (const command of ['java', 'gradle', 'python3', 'adb', 'go', 'rustc', 'node', 'mvn', 'flutter', 'kubectl', 'terraform', 'aws', 'gcloud']) {
    const hint = suggestToolchainForCommand(command);
    assert.ok(hint, `${command} should map to a provisioner`);
    assert.ok(provisionable.has(hint.kind), `${command} maps to unknown provisioner kind ${hint.kind}`);
  }
});
