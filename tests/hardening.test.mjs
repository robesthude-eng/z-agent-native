import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-hardening-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';
process.env.Z_AGENT_GREP_TIMEOUT_MS = '1000';
// Plain http on a private address: the relay must refuse to be used at all.
process.env.Z_AGENT_RELAY_URL = 'http://10.0.0.5';

const store = await import('../server/native/store.mjs');
const durable = await import('../server/native/durable-jobs.mjs');
const providers = await import('../server/native/providers.mjs');
const auth = await import('../server/native/auth.mjs');
const environment = await import('../server/native/environment.mjs');
const { compactFrames } = await import('../server/native/context.mjs');
const { executeTool } = await import('../server/native/tools.mjs');

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('an http or private relay URL is refused instead of silently proxying provider traffic', () => {
  assert.deepEqual(providers.relayStatus(), { enabled: false, host: null });
});

test('each chat receives its own sandbox uid', () => {
  store.createUser('h@example.com', 'hash');
  store.createChat('ses_hardening1', 'h@example.com', 'One');
  store.createChat('ses_hardening2', 'h@example.com', 'Two');
  const first = store.getSandboxUid('ses_hardening1');
  const second = store.getSandboxUid('ses_hardening2');
  assert.ok(first);
  assert.ok(second);
  assert.notDeepEqual(first, second);
});

test('a client supplied future timestamp cannot pin a message to the end of history', () => {
  store.putMessage({
    id: 'msg_future', sessionID: 'ses_hardening1', role: 'user',
    parts: [{ type: 'text', text: 'from the future' }], time: { created: Date.now() + 600_000 }, info: {},
  });
  store.putMessage({
    id: 'msg_now', sessionID: 'ses_hardening1', role: 'user',
    parts: [{ type: 'text', text: 'now' }], time: { created: Date.now() }, info: {},
  });
  const texts = store.listMessages('ses_hardening1').map((message) => message.parts[0].text);
  assert.deepEqual(texts, ['from the future', 'now']);
});

test('a failed idempotency key can be retried but a completed one still replays', () => {
  assert.equal(store.claimAction('ses_hardening1', 'act_retry'), true);
  store.failAction('ses_hardening1', 'act_retry', new Error('boom'));
  assert.equal(store.resetAction('ses_hardening1', 'act_retry'), true);
  assert.equal(store.getAction('ses_hardening1', 'act_retry').state, 'running');
  store.completeAction('ses_hardening1', 'act_retry', { ok: true });
  assert.equal(store.resetAction('ses_hardening1', 'act_retry'), false);
  assert.equal(store.getAction('ses_hardening1', 'act_retry').state, 'completed');
});

test('restart recovery leaves resumable sessions untouched', () => {
  store.setTurn('ses_hardening1', { turnId: 'trn_dead', lifecycle: 'running', since: Date.now() });
  store.setTurn('ses_hardening2', { turnId: 'trn_resumable', lifecycle: 'waiting_permission', since: Date.now() });
  store.createQuestion('que_hardening', 'ses_hardening2', [{ question: 'Continue?' }]);
  store.createPermission('per_hardening', 'ses_hardening2', 'bash', { command: 'true' });

  const failed = store.recoverInterruptedRuntimeState({ skipSessionIds: ['ses_hardening2'] });

  assert.equal(failed, 1);
  assert.equal(store.getTurn('ses_hardening1').lifecycle, 'failed');
  assert.equal(store.getTurn('ses_hardening2').lifecycle, 'waiting_permission');
  assert.equal(store.listPendingQuestions('ses_hardening2').length, 1);
  assert.ok(!store.getPermission('per_hardening').response);
});

test('a crashed durable turn stops blocking its session after the TTL', () => {
  durable.createDurableJob({ sessionId: 'ses_hardeningjob', ownerId: 'h@example.com' });
  assert.throws(() => durable.createDurableJob({ sessionId: 'ses_hardeningjob' }), /already exists/);

  const file = path.join(process.env.Z_AGENT_DATA_DIR, 'durable-jobs', 'ses_hardeningjob.json');
  const job = JSON.parse(fs.readFileSync(file, 'utf8'));
  job.createdAt = Date.now() - 48 * 60 * 60 * 1000;
  job.updatedAt = job.createdAt;
  fs.writeFileSync(file, JSON.stringify(job));

  durable.createDurableJob({ sessionId: 'ses_hardeningjob', ownerId: 'h@example.com' });
  assert.ok(durable.listDurableJobs().some((entry) => entry.sessionId === 'ses_hardeningjob'));
});

test('expired durable job files are pruned', () => {
  const dir = path.join(process.env.Z_AGENT_DATA_DIR, 'durable-jobs');
  fs.mkdirSync(dir, { recursive: true });
  const stale = Date.now() - 72 * 60 * 60 * 1000;
  fs.writeFileSync(path.join(dir, 'ses_hardeningstale.json'), JSON.stringify({ version: 1, sessionId: 'ses_hardeningstale', createdAt: stale, updatedAt: stale, state: 'running' }));

  assert.ok(durable.pruneExpiredDurableJobs(60 * 60 * 1000) >= 1);
  assert.ok(!durable.listDurableJobs().some((entry) => entry.sessionId === 'ses_hardeningstale'));
});

test('authentication failure limits are shared in SQLite across runtime callers', () => {
  const bucket = 'account:test-shared-rate-limit';
  for (let i = 0; i < 3; i += 1) store.recordAuthFailures([bucket], { windowMs: 60_000 }, 1_000 + i);
  assert.equal(store.authRateLimitExceeded([bucket], { [bucket]: 3 }, 2_000), true);
  assert.equal(store.authRateLimitExceeded([bucket], { [bucket]: 4 }, 2_000), false);
  assert.equal(store.authRateLimitExceeded([bucket], { [bucket]: 3 }, 70_000), false);
});

test('authentication sessions are stored as one-way token digests', () => {
  const token = 'raw-session-token-that-must-not-live-in-sqlite';
  store.createAuthSession(token, 'h@example.com', 'csrf-value');
  const found = store.getAuthSession(token);
  assert.equal(found.email, 'h@example.com');
  assert.match(found.token, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(found.token, token);
  store.deleteAuthSession(token);
  assert.equal(store.getAuthSession(token), null);
});

test('registration is closed once the bootstrap admin exists', { skip: (process.env.Z_AGENT_INVITE_CODE || process.env.Z_AGENT_ALLOW_OPEN_REGISTRATION === '1') ? 'invite code or open registration configured' : false }, () => {
  if (store.userCount() === 0) store.createUser('bootstrap@example.com', 'hash');
  assert.throws(() => auth.registerUser('intruder@example.com', 'password12345'), /закрыт/i);
});

test('package specs cannot smuggle VCS or URL installs', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-env-'));
  assert.throws(
    () => environment.prepareEnvironmentRequirement(workspace, { kind: 'python', packages: ['git+https://example.com/evil.git'] }),
    /Unsafe Python package spec/,
  );
  assert.ok(environment.prepareEnvironmentRequirement(workspace, { kind: 'python', packages: ['requests==2.32.5'] }));
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('one oversized frame no longer drops the whole older context', () => {
  const frames = [
    { role: 'user', content: 'oldest anchor marker' },
    { role: 'assistant', content: 'z'.repeat(400_000) },
    { role: 'user', content: 'recent one' },
    { role: 'user', content: 'recent two' },
  ];
  const compacted = compactFrames(frames, { maxChars: 20_000, maxObservationChars: 500_000 });
  const text = compacted.map((frame) => frame.content).join('\n');
  assert.match(text, /oldest anchor marker/);
  assert.match(text, /recent two/);
});

test('a catastrophic regex is cancelled by the grep deadline', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-grep-'));
  fs.writeFileSync(path.join(workspace, 'big.txt'), `${'a'.repeat(4000)}b\n`);
  const ctx = { workspace, signal: new AbortController().signal };
  await assert.rejects(
    executeTool('grep', { path: '.', query: '(a+)+$', regex: true }, ctx),
    /exceeded|cancelled/i,
  );
  fs.rmSync(workspace, { recursive: true, force: true });
});

test('local env loading stays developer-friendly while production forces hard boundaries', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  const api = compose.match(/^ {2}z-agent:\n([\s\S]*?)(?=^ {2}z-agent-executor:)/m)?.[1] || '';

  assert.match(pkg.scripts.start, /--env-file-if-exists=\.env/);
  assert.match(pkg.scripts.dev, /--env-file-if-exists=\.env/);
  assert.match(envExample, /^Z_AGENT_EXECUTOR_REQUIRED=0$/m);
  assert.match(envExample, /^Z_AGENT_BROWSER_REQUIRED=0$/m);
  assert.match(envExample, /^Z_AGENT_TERMINAL_ENABLED=1$/m);
  assert.match(api, /Z_AGENT_EXECUTOR_REQUIRED:\s*['"]?1['"]?/);
  assert.match(api, /Z_AGENT_BROWSER_REQUIRED:\s*['"]?1['"]?/);
  assert.match(api, /Z_AGENT_TERMINAL_ENABLED:\s*['"]?0['"]?/);
});

test('production compose pins persistent runtime paths instead of inheriting bare-metal .env paths', () => {
  const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  const api = compose.match(/^ {2}z-agent:\n([\s\S]*?)(?=^ {2}z-agent-executor:)/m)?.[1] || '';
  assert.match(api, /Z_AGENT_DATA_DIR:\s*\/data/);
  assert.match(api, /Z_AGENT_WORKSPACES_DIR:\s*\/workspaces/);
  assert.match(api, /z-agent-data:\/data/);
  assert.match(api, /z-agent-workspaces:\/workspaces/);
});

test('production compose isolates autonomous execution in a networkless sibling service', () => {
  const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  assert.match(compose, /z-agent-executor:[\s\S]*network_mode:\s*none/);
  assert.match(compose, /Z_AGENT_EXECUTOR_REQUIRED:\s*['"]?1['"]?/);
  assert.match(compose, /Z_AGENT_EXECUTOR_EXPECT_NETWORK_NONE:\s*['"]?1['"]?/);
  const executorBlock = compose.split(/\n\s{2}z-agent-executor:\s*\n/)[1]?.split(/\nvolumes:\s*\n/)[0] || '';
  assert.match(executorBlock, /z-agent-workspaces:\/workspaces/);
  assert.doesNotMatch(executorBlock, /z-agent-data:\/data/);
  // Session dirs are 0700. Without DAC_OVERRIDE, spawn({cwd}) is EACCES and
  // Node misreports it as `spawn setpriv EACCES`, so bash/git/tests all die.
  assert.match(executorBlock, /DAC_OVERRIDE/);
});

test('the automatically loaded compose override cannot weaken the hardened executor', () => {
  const override = fs.readFileSync(path.join(repoRoot, 'docker-compose.override.yml'), 'utf8');
  const trusted = fs.readFileSync(path.join(repoRoot, 'docker-compose.trusted.yml'), 'utf8');
  assert.doesNotMatch(override, /Z_AGENT_TERMINAL_ENABLED|Z_AGENT_ALLOW_NETWORKED_INSTALLERS|network_mode:\s*!override\s+bridge|Z_AGENT_SSH_POLICY/);
  assert.match(trusted, /Z_AGENT_TERMINAL_ENABLED:\s*['"]?1['"]?/);
  assert.match(trusted, /Z_AGENT_ALLOW_NETWORKED_INSTALLERS:\s*['"]?1['"]?/);
  assert.match(trusted, /network_mode:\s*!override\s+bridge/);
  assert.match(trusted, /Z_AGENT_SSH_POLICY:\s*any/);
});

test('production browser has an internal-only network and a separate pinned egress proxy', () => {
  const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  const browserBlock = compose.match(/^ {2}z-agent-browser:\n([\s\S]*?)(?=^ {2}z-agent-browser-egress:)/m)?.[1] || '';
  const proxyBlock = compose.match(/^ {2}z-agent-browser-egress:\n([\s\S]*?)(?=^volumes:)/m)?.[1] || '';
  const apiBlock = compose.match(/^ {2}z-agent:\n([\s\S]*?)(?=^ {2}z-agent-executor:)/m)?.[1] || '';
  assert.match(browserBlock, /Dockerfile\.browser/);
  assert.match(browserBlock, /cap_add:[\s\S]*CHOWN[\s\S]*FOWNER[\s\S]*SETUID[\s\S]*SETGID/);
  assert.match(browserBlock, /Z_AGENT_BROWSER_PROXY:\s*http:\/\/z-agent-browser-egress:8080/);
  assert.match(browserBlock, /- browser-sandbox/);
  assert.doesNotMatch(browserBlock, /- runtime-egress|- browser-egress/);
  assert.doesNotMatch(browserBlock, /env_file:|z-agent-data:\/data|z-agent-workspaces:\/workspaces/);
  assert.match(proxyBlock, /user:\s*node/);
  assert.match(proxyBlock, /- browser-sandbox/);
  assert.match(proxyBlock, /- browser-egress/);
  assert.doesNotMatch(proxyBlock, /env_file:|volumes:|z-agent-data|z-agent-workspaces/);
  assert.match(compose, /browser-sandbox:\n\s+internal:\s*true/);
  assert.match(apiBlock, /- runtime-egress/);
  assert.doesNotMatch(apiBlock, /browser-sandbox|browser-egress/);
});

test('model-selected process-capable Git operations cross the networkless executor boundary', () => {
  const gitTool = fs.readFileSync(path.join(repoRoot, 'server/native/git-tool.mjs'), 'utf8');
  const toolsSource = fs.readFileSync(path.join(repoRoot, 'server/native/tools.mjs'), 'utf8');
  const changes = fs.readFileSync(path.join(repoRoot, 'server/native/git-changes.mjs'), 'utf8');
  const results = fs.readFileSync(path.join(repoRoot, 'server/native/turn-results.mjs'), 'utf8');
  assert.match(gitTool, /executeInExecutor/);
  assert.match(toolsSource, /executeInExecutor[\s\S]*git apply/);
  assert.match(changes, /executeInExecutorSync/);
  assert.match(results, /args\[0\] === 'add'[\s\S]*executeInExecutorSync/);
});

test('public app and TLS proxy ship restrictive browser security headers', () => {
  const caddy = fs.readFileSync(path.join(repoRoot, 'Caddyfile'), 'utf8');
  const server = fs.readFileSync(path.join(repoRoot, 'server/index.mjs'), 'utf8');
  assert.match(caddy, /Strict-Transport-Security/);
  assert.match(caddy, /X-Content-Type-Options\s+"nosniff"/);
  assert.match(caddy, /Referrer-Policy\s+"no-referrer"/);
  assert.match(caddy, /Permissions-Policy/);
  assert.match(server, /APP_CONTENT_SECURITY_POLICY_BASE/);
  assert.match(server, /script-src 'self'/);
  assert.match(server, /object-src 'none'/);
  assert.doesNotMatch(server.match(/const APP_CONTENT_SECURITY_POLICY = \[[\s\S]*?\]\.join\('; '\);/)?.[0] || '', /connect-src 'self' https:\s/);
});

test('readiness includes a persistent-volume free-space floor', () => {
  const readiness = fs.readFileSync(path.join(repoRoot, 'server/native/readiness.mjs'), 'utf8');
  assert.match(readiness, /Z_AGENT_MIN_FREE_BYTES/);
  assert.match(readiness, /statfsSync/);
  assert.match(readiness, /free space is below the readiness floor/);
});

test('automatic deploy refuses schema-breaking rollback contracts and has no bypass flag', () => {
  const deploy = fs.readFileSync(path.join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');
  const migrations = fs.readFileSync(path.join(repoRoot, 'server/native/migrations.mjs'), 'utf8');
  assert.match(migrations, /SCHEMA_MIN_READER_VERSION/);
  assert.match(deploy, /CURRENT_SCHEMA_READER/);
  assert.match(deploy, /CANDIDATE_MIN_READER/);
  assert.doesNotMatch(deploy, /Z_AGENT_ALLOW_BREAKING_MIGRATION/);
  assert.match(deploy, /image rollback would not be schema-safe/);
});

test('12-character password policy does not lock out legacy-login passwords in the UI', () => {
  const login = fs.readFileSync(path.join(repoRoot, 'src/components/LoginPage.tsx'), 'utf8');
  assert.match(login, /if \(isRegistering && password\.length < 12\)/);
  assert.doesNotMatch(login, /if \(!password \|\| password\.length < 12\)/);
});


test('production requires strict external encryption and audit keys', () => {
  const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  const api = compose.match(/^ {2}z-agent:\n([\s\S]*?)(?=^ {2}z-agent-executor:)/m)?.[1] || '';
  assert.match(api, /Z_AGENT_SECRET_KEY_STRICT:\s*['"]?1['"]?/);
  assert.match(api, /Z_AGENT_REQUIRE_EXTERNAL_KEYS:\s*['"]?1['"]?/);
  const secrets = fs.readFileSync(path.join(repoRoot, 'server/native/secrets.mjs'), 'utf8');
  const audit = fs.readFileSync(path.join(repoRoot, 'server/native/audit.mjs'), 'utf8');
  assert.match(secrets, /Z_AGENT_SECRET_KEY_FILE/);
  assert.match(secrets, /Production requires Z_AGENT_SECRET_KEY/);
  assert.match(audit, /Z_AGENT_AUDIT_KEY_FILE/);
  assert.match(audit, /Production requires Z_AGENT_AUDIT_KEY/);
});

test('public reverse proxy refuses the operator metrics endpoint', () => {
  const caddy = fs.readFileSync(path.join(repoRoot, 'Caddyfile'), 'utf8');
  assert.match(caddy, /@metrics path \/metrics[\s\S]*respond @metrics 404/);
});

test('release pipeline deploys exactly the images tested by CI', () => {
  const ci = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const deploy = fs.readFileSync(path.join(repoRoot, '.github/workflows/deploy.yml'), 'utf8');
  const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  assert.match(ci, /docker compose up -d --no-build/);
  assert.match(ci, /docker push "\$API_TAG"[\s\S]*docker pull "\$API_TAG"[\s\S]*RepoDigests/);
  assert.match(ci, /production-images\.env\.sha256/);
  assert.match(deploy, /gh run download[\s\S]*production-images/);
  assert.match(deploy, /sha256sum -c production-images\.env\.sha256/);
  assert.match(deploy, /docker pull "\$Z_AGENT_API_IMAGE"/);
  assert.match(deploy, /docker compose run --rm --no-deps --entrypoint node z-agent[\s\S]*server\/backup\.mjs/);
  assert.doesNotMatch(deploy, /docker compose exec -T z-agent node \/tmp\/z-agent-backup\.mjs/);
  assert.match(deploy, /docker compose up -d --no-build/);
  assert.doesNotMatch(deploy, /docker compose build/);
  assert.match(compose, /image: \$\{Z_AGENT_API_IMAGE:-z-agent-native:local\}/);
  assert.match(compose, /image: \$\{Z_AGENT_BROWSER_IMAGE:-z-agent-browser:local\}/);
});

test('production Dockerfiles pin the Node release instead of floating on major 24', () => {
  const api = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
  const browser = fs.readFileSync(path.join(repoRoot, 'Dockerfile.browser'), 'utf8');
  assert.match(api, /^FROM node:24\.19\.0-bookworm AS build/m);
  assert.match(api, /^FROM node:24\.19\.0-bookworm-slim AS runtime/m);
  assert.match(browser, /^FROM node:24\.19\.0-bookworm$/m);
  assert.match(browser, /PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright/);
  assert.match(browser, /chmod -R a\+rX \/ms-playwright/);
});

test('production API drains active turns before Docker may SIGKILL it', () => {
  const server = fs.readFileSync(path.join(repoRoot, 'server/index.mjs'), 'utf8');
  const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  assert.match(server, /DRAINING = true/);
  assert.match(server, /activeTurnCount\(\) > 0/);
  assert.match(server, /Z_AGENT_SHUTDOWN_GRACE_MS/);
  assert.match(server, /status: 'draining'/);
  assert.match(compose, /z-agent:[\s\S]*stop_grace_period:\s*75s/);
});

test('an uncaught fault is recorded and turned into a clean restart, not a silent crash', () => {
  const server = fs.readFileSync(path.join(repoRoot, 'server/index.mjs'), 'utf8');
  // Node's default for both of these is a crash with no record of the cause.
  // Handling them must still end the process, so durable recovery gets a clean
  // boot rather than a runtime serving from a suspect heap.
  assert.match(server, /process\.on\('unhandledRejection'/);
  assert.match(server, /process\.on\('uncaughtException'/);
  assert.match(server, /level: 'fatal'/);
  assert.match(server, /shutdown\(kind, \{ graceMs: FATAL_GRACE_MS \}\)/);
  assert.match(server, /setTimeout\(\(\) => process\.exit\(1\), FATAL_GRACE_MS/);
});

test('every long-lived sidecar records a fault instead of dying silently', () => {
  // The API server has always done this; the processes it depends on did not,
  // so a fault in any of them surfaced only as an unexplained restart. Each one
  // must also release what it owns on the way out, or the restart leaves
  // untracked children behind.
  const releases = {
    'server/executor.mjs': /killChild\(child, 'SIGKILL'\)/,
    'server/browser-service.mjs': /stopWorker\(state, 'SIGKILL'\)/,
    'server/browser-egress.mjs': /for \(const socket of sockets\) socket\.destroy\(\)/,
    // Skipping this orphans the Chromium processes the worker spawned.
    'server/browser-worker.mjs': /shutdown\(1\)/,
  };
  for (const [file, releasesOwned] of Object.entries(releases)) {
    const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    assert.match(source, /process\.on\('unhandledRejection'/, `${file} must record an unhandled rejection`);
    assert.match(source, /process\.on\('uncaughtException'/, `${file} must record an uncaught exception`);
    assert.match(source, /level: 'fatal'/, `${file} must log the fault in the shared fatal shape`);
    assert.match(source, /process\.exitCode = 1/, `${file} must exit non-zero so the supervisor restarts it`);
    assert.match(source, releasesOwned, `${file} must release what it owns before exiting`);
  }
});

test('the API image carries its own readiness probe, not only the Compose one', () => {
  const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
  const compose = fs.readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  assert.match(dockerfile, /^HEALTHCHECK /m);
  assert.match(dockerfile, /\/health\/ready/);
  // A bare `docker run` must not get a weaker contract than the composed
  // deployment, so image metadata and Compose probe the same endpoint.
  assert.match(compose, /z-agent:[\s\S]*health\/ready/);
});

test('every CI job is a blocking gate', () => {
  const ci = fs.readFileSync(path.join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  assert.doesNotMatch(ci, /continue-on-error:\s*true/);
  assert.match(ci, /npm run lint:ci/);
  assert.match(ci, /npm run format:check/);
});

test('the in-process browser fallback bounds concurrent Chromium sessions', () => {
  const browser = fs.readFileSync(path.join(repoRoot, 'server/native/browser.mjs'), 'utf8');
  const service = fs.readFileSync(path.join(repoRoot, 'server/browser-service.mjs'), 'utf8');
  // The isolated service has always had a worker ceiling; the local fallback
  // must not be the unbounded path around it.
  assert.match(service, /Z_AGENT_BROWSER_MAX_WORKERS/);
  assert.match(browser, /Z_AGENT_BROWSER_MAX_SESSIONS/);
  assert.match(browser, /while \(sessions\.size >= MAX_SESSIONS\)/);
});
