import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.Z_AGENT_NETWORK_POLICY = 'public';
process.env.Z_AGENT_SSH_POLICY = 'any';
process.env.Z_AGENT_ALLOW_NETWORKED_INSTALLERS = '1';

import { GIT_ACTIONS, buildGitArgs, executeGitTool, findRepoDir, gitActionMutates, pickInitDir } from '../server/native/git-tool.mjs';
import { buildTestCommand, formatTestReport, guessFramework, parseTestOutput } from '../server/native/test-runner.mjs';
import { formatDiagnosticsReport, parseDiagnostics, planDiagnostics } from '../server/native/diagnostics.mjs';
import { BROWSER_ACTIONS, browserUnavailableMessage, executeBrowserTool } from '../server/native/browser.mjs';
import { getSubagentProfile, subagentKinds, subagentToolNames, subagentWrites } from '../server/native/subagents.mjs';
import { TOOL_DEFINITIONS, availableToolDefinitions, mutatesWorkspace, requiresPermission } from '../server/native/tools.mjs';
import { buildSshArgs } from '../server/native/ssh-tool.mjs';

function tempRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devtools-'));
  test.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function source(relative) {
  return fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
}

/* ------------------------------- git tool ------------------------------- */

test('git builds fixed argv per action instead of a shell string', () => {
  const root = tempRoot();
  assert.deepEqual(buildGitArgs(root, 'status').args, ['status', '--porcelain=v1', '--branch']);
  assert.deepEqual(buildGitArgs(root, 'branches').args, ['branch', '--all', '--verbose', '--no-color']);
  assert.ok(buildGitArgs(root, 'log', { limit: 5 }).args.includes('--max-count=5'));
  assert.deepEqual(buildGitArgs(root, 'create_branch', { branch: 'feature/ok' }).args, ['checkout', '-b', 'feature/ok']);
});

test('git log clamps limit into a sane range', () => {
  const root = tempRoot();
  assert.ok(buildGitArgs(root, 'log', { limit: 99999 }).args.includes('--max-count=200'));
  // A negative limit clamps to the floor rather than silently reverting to the
  // default, so the argv stays bounded and predictable either way.
  assert.ok(buildGitArgs(root, 'log', { limit: -4 }).args.includes('--max-count=1'));
  assert.ok(buildGitArgs(root, 'log', { limit: 'abc' }).args.includes('--max-count=20'));
  assert.ok(buildGitArgs(root, 'log', {}).args.includes('--max-count=20'));
});

test('git rejects revisions that would be parsed as options', () => {
  const root = tempRoot();
  assert.throws(() => buildGitArgs(root, 'log', { rev: '--upload-pack=touch /tmp/pwn' }), /must not start with/);
  assert.throws(() => buildGitArgs(root, 'show', { rev: '-o' }), /must not start with/);
});

test('git rejects shell metacharacters in revisions', () => {
  const root = tempRoot();
  for (const rev of ['HEAD; rm -rf /', 'HEAD && whoami', 'HEAD$(id)', 'HEAD|cat']) {
    assert.throws(() => buildGitArgs(root, 'log', { rev }), /unsupported characters/, `expected ${rev} to be rejected`);
  }
});

test('git confines path arguments to the workspace', () => {
  const root = tempRoot();
  assert.throws(() => buildGitArgs(root, 'log', { paths: ['../../etc/passwd'] }));
  assert.throws(() => buildGitArgs(root, 'log', { paths: ['/etc/passwd'] }));
});

test('git separates paths from revisions with an explicit --', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'a.txt'), 'x');
  const { args } = buildGitArgs(root, 'log', { rev: 'HEAD', paths: ['a.txt'] });
  const separator = args.indexOf('--');
  assert.ok(separator > 0, 'expected a -- separator');
  assert.equal(args[separator + 1], 'a.txt');
  assert.ok(args.indexOf('HEAD') < separator, 'revision must precede the separator');
});

test('git blame requires exactly one path', () => {
  const root = tempRoot();
  assert.throws(() => buildGitArgs(root, 'blame', { paths: [] }), /exactly one/);
});

test('git rejects unsafe branch names', () => {
  const root = tempRoot();
  for (const branch of ['-D', 'a..b', 'has space', 'quote"name']) {
    assert.throws(() => buildGitArgs(root, 'create_branch', { branch }), /not allowed/, `expected ${branch} to be rejected`);
  }
});

test('git classifies mutating actions correctly', () => {
  assert.equal(gitActionMutates('commit'), true);
  assert.equal(gitActionMutates('create_branch'), true);
  assert.equal(gitActionMutates('log'), false);
  assert.equal(gitActionMutates('status'), false);
});

test('git rejects unknown actions before spawning anything', async () => {
  await assert.rejects(
    () => executeGitTool({ root: tempRoot(), identity: { isolated: false }, input: { action: 'push' } }),
    /Unsupported git action/,
  );
  assert.ok(!GIT_ACTIONS.includes('push'), 'push must not be exposed');
});

test('git detects a repository in a project subfolder', () => {
  // Распакованный архив: репозитория в корне нет, .git — в подпапке проекта.
  const root = tempRoot();
  const project = path.join(root, 'z-agent-native-main');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.mkdirSync(path.join(project, '.git'));
  assert.equal(findRepoDir(root, {}), root, 'without paths the workspace root is used');
  assert.equal(
    findRepoDir(root, { paths: ['z-agent-native-main/src/index.css'] }),
    project,
    'deepest ancestor with .git wins over the root',
  );
});

test('git pickInitDir prefers the project marker folder for auto-init', () => {
  const root = tempRoot();
  const project = path.join(root, 'unpacked-project');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  assert.equal(pickInitDir(root, { paths: ['unpacked-project/src/app.tsx'] }), project);
  // Нет маркеров — init остаётся в корне воркспейса.
  const bare = tempRoot();
  fs.mkdirSync(path.join(bare, 'somedir'), { recursive: true });
  assert.equal(pickInitDir(bare, { paths: ['somedir/a.txt'] }), bare);
  assert.equal(pickInitDir(bare, {}), bare);
});

test('git auto-initializes a missing repository and reports status', async () => {
  const root = tempRoot();
  const project = path.join(root, 'proj');
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{}');
  fs.writeFileSync(path.join(project, 'src', 'a.ts'), 'export {};\n');

  const result = await executeGitTool({
    root,
    identity: { isolated: false },
    input: { action: 'status', paths: ['proj/src/a.ts'] },
  });
  assert.match(result.output, /## (No commits yet|master|main)/);
  assert.ok(fs.statSync(path.join(project, '.git')).isDirectory(), 'git init должен создать .git в папке проекта');

  // Повторный вызов находит уже созданный репозиторий без повторного init.
  const again = await executeGitTool({
    root,
    identity: { isolated: false },
    input: { action: 'status', paths: ['proj/src/a.ts'] },
  });
  assert.match(again.output, /No commits yet|nothing to commit|\?\?/);
});

test('git explains that an empty repository needs a first commit', async () => {
  const root = tempRoot();
  await assert.rejects(
    () => executeGitTool({ root, identity: { isolated: false }, input: { action: 'log' } }),
    /no commits yet/i,
  );
});

/* ------------------------------ test runner ----------------------------- */

test('test runner detects npm projects and honours filters', () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
  const plan = buildTestCommand(root, {});
  assert.equal(plan.command, 'npm test');
  assert.equal(plan.framework, 'vitest');

  const filtered = buildTestCommand(root, { filter: 'parses diff' });
  assert.equal(filtered.command, 'npm test -- parses diff');
});

test('an explicit command still applies the filter', () => {
  const root = tempRoot();
  const plan = buildTestCommand(root, { command: 'pytest -q', filter: 'test_login' });
  assert.equal(plan.command, 'pytest -q test_login');
  assert.equal(plan.framework, 'pytest');
});

test('test runner fails loudly when no runner can be detected', () => {
  assert.throws(() => buildTestCommand(tempRoot(), {}), /No test command could be detected/);
});

test('guessFramework recognises the common runners', () => {
  assert.equal(guessFramework('npx vitest run'), 'vitest');
  assert.equal(guessFramework('node --test tests/'), 'node');
  assert.equal(guessFramework('go test ./...'), 'go');
  assert.equal(guessFramework('mystery-runner'), 'unknown');
});

test('test output parsing extracts failures across runners', () => {
  const tap = parseTestOutput('ok 1 - fine\nnot ok 2 - reconnect drops the queue\n# pass 1\n# fail 1');
  assert.equal(tap.totals.passed, 1);
  assert.equal(tap.totals.failed, 1);
  assert.ok(tap.failures.some((item) => item.name === 'reconnect drops the queue'));

  const pytest = parseTestOutput('FAILED tests/test_auth.py::test_expired_token - AssertionError');
  assert.ok(pytest.failures.some((item) => item.name === 'test_expired_token' && item.file === 'tests/test_auth.py'));

  const go = parseTestOutput('--- FAIL: TestRetryBudget (0.01s)');
  assert.ok(go.failures.some((item) => item.name === 'TestRetryBudget'));
});

test('test report states PASSED only on a zero exit code', () => {
  const passed = formatTestReport({ command: 'npm test', framework: 'node', source: 's', exitCode: 0, output: '# pass 4\n# fail 0' });
  assert.match(passed.text, /status: PASSED/);

  const failed = formatTestReport({ command: 'npm test', framework: 'node', source: 's', exitCode: 1, output: 'not ok 1 - broke\n# fail 1' });
  assert.match(failed.text, /status: FAILED/);
  assert.match(failed.text, /broke/);
});

test('a crashed runner is never reported as a pass', () => {
  const report = formatTestReport({
    command: 'npm test',
    framework: 'node',
    source: 's',
    exitCode: 127,
    output: 'sh: vitest: command not found',
  });
  assert.match(report.text, /status: FAILED/);
  assert.doesNotMatch(report.text, /status: PASSED/);
  assert.match(report.text, /command not found/);
});

/* ------------------------------ diagnostics ----------------------------- */

test('diagnostics parses tsc, eslint and gcc-style output', () => {
  const tsc = parseDiagnostics('src/app.ts(12,5): error TS2345: Argument of type string is not assignable');
  assert.equal(tsc.length, 1);
  assert.equal(tsc[0].file, 'src/app.ts');
  assert.equal(tsc[0].line, 12);
  assert.equal(tsc[0].column, 5);
  assert.equal(tsc[0].code, 'TS2345');
  assert.equal(tsc[0].severity, 'error');

  const eslint = parseDiagnostics('src/index.js\n  3:10  error  Unexpected var  no-var\n  4:2  warning  Missing semi  semi\n');
  assert.ok(eslint.some((item) => item.file === 'src/index.js' && item.line === 3 && item.severity === 'error'));
  assert.ok(eslint.some((item) => item.severity === 'warning' && item.line === 4));

  const gcc = parseDiagnostics('app.py:4:1: error: undefined name foo');
  assert.ok(gcc.some((item) => item.file === 'app.py' && item.line === 4));
});

test('diagnostics ignores note lines and de-duplicates repeats', () => {
  const parsed = parseDiagnostics([
    'a.ts(1,1): error TS1005: missing token',
    'a.ts(1,1): error TS1005: missing token',
    'a.ts:2:1: note: see declaration',
  ].join('\n'));
  assert.equal(parsed.length, 1);
});

test('diagnostics report is CLEAN only with a zero exit and no findings', () => {
  const clean = formatDiagnosticsReport([{ kind: 'typecheck', command: 'tsc --noEmit', exitCode: 0, output: '' }]);
  assert.match(clean.text, /status: CLEAN/);
  assert.equal(clean.errorCount, 0);
  assert.equal(clean.ok, true);

  const dirty = formatDiagnosticsReport([{
    kind: 'typecheck',
    command: 'tsc --noEmit',
    exitCode: 2,
    output: 'src/a.ts(3,3): error TS2322: Type error',
  }]);
  assert.match(dirty.text, /status: ISSUES/);
  assert.equal(dirty.errorCount, 1);
  assert.equal(dirty.ok, false);
});

test('a checker that failed to start is not reported as clean', () => {
  const report = formatDiagnosticsReport([{
    kind: 'lint',
    command: 'npx eslint .',
    exitCode: 127,
    output: 'sh: eslint: command not found',
  }]);
  assert.match(report.text, /status: ISSUES/);
  assert.match(report.text, /may have failed to start/);
  assert.equal(report.ok, false);
});

test('diagnostics planning detects config and fails loudly otherwise', () => {
  const root = tempRoot();
  assert.throws(() => planDiagnostics(root, {}), /No typecheck or lint command/);

  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}');
  const plans = planDiagnostics(root, { kind: 'typecheck' });
  assert.equal(plans.length, 1);
  assert.match(plans[0].command, /tsc --noEmit/);

  assert.throws(() => planDiagnostics(root, { kind: 'spellcheck' }), /Unsupported diagnostics kind/);
});

/* -------------------------------- browser ------------------------------- */

test('browser refuses unknown actions and sessionless use', async () => {
  await assert.rejects(() => executeBrowserTool({ sessionId: 's1', input: { action: 'exploit' } }), /Unsupported browser action/);
  await assert.rejects(() => executeBrowserTool({ sessionId: '', input: { action: 'open', url: 'https://example.com' } }), /session sandbox/);
});

test('closing a browser that was never opened is a no-op, not a crash', async () => {
  const result = await executeBrowserTool({ sessionId: 'never-opened', input: { action: 'close' } });
  assert.match(result.output, /No browser session was open/);
});

test('browser degrades with an actionable message when Playwright is absent', () => {
  assert.match(browserUnavailableMessage(), /Playwright/);
  assert.match(browserUnavailableMessage(), /playwright install/);
  assert.ok(BROWSER_ACTIONS.includes('snapshot') && BROWSER_ACTIONS.includes('close'));
});

test('browser explains why dev-server localhost is unreachable instead of ERR_BLOCKED_BY_CLIENT', async () => {
  // Дев-сервер песочницы физически недоступен из браузера (executor без сети):
  // модель должна получить рецепт «собери статику и открой workspace-файл»,
  // а не загадочный ERR_BLOCKED_BY_CLIENT от прокси.
  for (const url of ['http://127.0.0.1:5173/', 'http://localhost:3000/', 'http://10.0.0.5:8080/']) {
    await assert.rejects(
      () => executeBrowserTool({ sessionId: 's-local', input: { action: 'open', url } }),
      (error) => {
        assert.equal(error.code, 'BROWSER_LOCAL_ADDRESS', url);
        assert.match(error.message, /dist\/index\.html|workspace/);
        return true;
      },
      `expected ${url} to be rejected with guidance`,
    );
  }
  // Рабочие workspace-пути остаются доступны: локальной проверки на них нет.
  await assert.rejects(
    () => executeBrowserTool({ sessionId: 's-local2', input: { action: 'open', url: 'dist/index.html' } }),
    (error) => error.code !== 'BROWSER_LOCAL_ADDRESS',
  );
});

/* ------------------------------- subagents ------------------------------ */

test('implement is the only writing subagent profile', () => {
  assert.ok(subagentKinds().includes('implement'));
  assert.equal(subagentWrites('implement'), true);
  for (const kind of ['explore', 'debug', 'review', 'planner', 'security', 'tester']) {
    assert.equal(subagentWrites(kind), false, `${kind} must stay read-only`);
  }
});

test('parent and subagent prompts treat repository instructions as untrusted data', () => {
  const parent = source('server/system-instruction.txt');
  assert.match(parent, /prompt-injection|prompt injection/i);
  assert.match(parent, /untrusted data/i);
  assert.match(parent, /Only system\/runtime policy and the user's actual request/i);
  for (const kind of subagentKinds()) {
    assert.match(getSubagentProfile(kind).system, /untrusted data/i, `${kind} must inherit prompt-injection guidance`);
  }
});

test('read-only subagent prompts forbid modification, implement demands verification', () => {
  for (const kind of ['explore', 'debug', 'review', 'planner', 'security', 'tester']) {
    assert.match(getSubagentProfile(kind).system, /Do not modify files/);
  }
  const implement = getSubagentProfile('implement');
  assert.match(implement.system, /run_tests/);
  assert.match(implement.system, /Never report success/);
  assert.doesNotMatch(implement.system, /Do not modify files/);
});

test('an unknown subagent kind falls back to the read-only explorer', () => {
  assert.equal(getSubagentProfile('root-me').name, 'explore');
  assert.equal(subagentWrites('root-me'), false);
});

/* ---------------------------- tool registration -------------------------- */

test('the new tools are registered with schemas', () => {
  for (const name of ['git', 'run_tests', 'diagnostics', 'browser', 'ssh_tool']) {
    const tool = TOOL_DEFINITIONS.find((item) => item.name === name);
    assert.ok(tool, `${name} must be registered`);
    assert.ok(tool.description.length > 40, `${name} needs a usable description`);
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
});

test('the task schema is generated from the profile registry', () => {
  const task = TOOL_DEFINITIONS.find((item) => item.name === 'task');
  assert.deepEqual(task.inputSchema.properties.agent.enum, subagentKinds());
  assert.ok(task.inputSchema.properties.agent.enum.includes('implement'));
});

test('the task description explains every role the schema accepts', () => {
  // Роль, которую не описали в description, модель не выберет никогда:
  // формально доступный субагент остаётся мёртвым кодом.
  const task = TOOL_DEFINITIONS.find((item) => item.name === 'task');
  for (const kind of subagentKinds()) {
    assert.ok(task.description.includes(kind), `${kind} must be described for the caller`);
  }
});

test('process-spawning tools are gated and classified', () => {
  for (const name of ['git', 'run_tests', 'diagnostics', 'browser', 'ssh_tool']) {
    assert.equal(requiresPermission(name), true, `${name} must be permission-gated`);
  }
  assert.equal(mutatesWorkspace('run_tests'), true);
  assert.equal(mutatesWorkspace('git'), true);
  assert.equal(mutatesWorkspace('diagnostics'), false);
  assert.equal(mutatesWorkspace('browser'), false);
  // Remote edits never touch the local snapshot, so ssh_tool must not dirty it.
  assert.equal(mutatesWorkspace('ssh_tool'), false);
});

/* -------------------------------- ssh_tool -------------------------------- */

test('ssh_tool builds structured argv instead of a shell string', () => {
  const plan = buildSshArgs('/tmp', 'exec', { host: '158.160.149.54', user: 'casano', command: 'uptime' });
  assert.deepEqual(plan.args, [
    'exec', '--host', '158.160.149.54', '--user', 'casano', '--port', '22', '--timeout', '60', '--cmd', 'uptime',
  ]);
});

test('ssh_tool rejects option-like hosts and unknown service actions', () => {
  // A host beginning with '-' is how an innocent-looking argument turns into
  // arbitrary ssh options such as -oProxyCommand.
  assert.throws(() => buildSshArgs('/tmp', 'exec', { host: '-oProxyCommand=id', command: 'id' }), /host/);
  assert.throws(() => buildSshArgs('/tmp', 'service', { host: 'h', name: 'nginx', serviceAction: 'nuke' }), /serviceAction/);
});

test('remote file content travels over stdin, never on the command line', () => {
  const plan = buildSshArgs('/tmp', 'write', { host: 'h', path: '/etc/motd', content: 'x'.repeat(5000) });
  assert.equal(plan.stdin.length, 5000);
  assert.ok(!plan.args.some((arg) => arg.length === 5000), 'content must not appear in argv');
});

test('bash turns the unnamed-uid ssh failure into an actionable instruction', () => {
  // Without this mapping the model reads a permanent sandbox property as a
  // credentials problem and retries until the loop guard stops the run.
  const tools = source('server/native/tools.mjs');
  assert.match(tools, /No user exists for uid/);
  assert.match(tools, /Use the ssh_tool tool instead/);
});

test('without a shell sandbox no process-spawning tool is advertised', () => {
  const names = availableToolDefinitions().map((tool) => tool.name);
  const spawning = ['bash', 'apply_patch', 'ensure_environment', 'git', 'run_tests', 'diagnostics', 'browser', 'ssh_tool'];
  const exposed = spawning.filter((name) => names.includes(name));
  // Either the sandbox is available and all of them are exposed, or none are.
  assert.ok(exposed.length === spawning.length || exposed.length === 0, `partial exposure: ${exposed.join(', ')}`);
});

test('websearch uses the DNS-pinned external transport rather than ambient fetch', () => {
  const tools = source('server/native/tools.mjs');
  const search = source('server/native/websearch.mjs');
  const block = tools.slice(tools.indexOf("if (tool === 'websearch')"), tools.indexOf("if (tool === 'webfetch')"));
  assert.match(block, /runWebSearch/);
  assert.match(search, /safeExternalRequest/);
  assert.doesNotMatch(search, /await fetch\(/);
  assert.doesNotMatch(block, /await fetch\(/);
});

test('browser applies agent network policy to every routed request and blocks service-worker/websocket bypasses', () => {
  const browser = source('server/native/browser.mjs');
  assert.match(browser, /context\.route\('\*\*\/\*'/);
  assert.match(browser, /assertAgentNetworkUrl\(target/);
  assert.match(browser, /assertSafeExternalUrl\(target/);
  assert.match(browser, /serviceWorkers: 'block'/);
  assert.match(browser, /routeWebSocket/);
  assert.match(browser, /setContent\(/);
});

/* --------------------------- subagent wiring ---------------------------- */

test('the writer subagent capability registry grants verification but not delegation', () => {
  const writer = subagentToolNames('implement');
  for (const name of ['write', 'edit', 'bash', 'git', 'run_tests', 'diagnostics']) {
    assert.ok(writer.includes(name), `${name} must be delegable`);
  }
  assert.ok(!writer.includes('task'), 'subagents must not recursively delegate');
  assert.ok(!writer.includes('question'), 'subagents cannot reach the user');
});

test('a writer subagent inherits the parent session sandbox and reports mutations', () => {
  const runner = source('server/native/subagent-runner.mjs');
  const agent = source('server/native/agent.mjs');
  // Only the writing subagent inherits sessionId (the sandbox identity), while
  // ownerId travels with every branch so provider-backed media tools can resolve
  // the same account credentials the parent turn uses.
  assert.match(runner, /subagentWrites\(profile\.name\) \? \{ workspace, sessionId, ownerId, signal \} : \{ workspace, ownerId, signal \}/);
  assert.match(runner, /mutatedPaths: \[\.\.\.mutatedPaths\]/);
  assert.match(agent, /runSubagent\(\{[\s\S]*projectContext: runtime\.projectContext,[\s\S]*sessionId/);
  assert.match(agent, /executeTool\(call\.name, call\.arguments \|\| \{\}, \{ workspace, sessionId, ownerId: runtime\.ownerId,/);
});

test('subagent tools are resolved against sandbox availability, not a static advertised list', () => {
  const runner = source('server/native/subagent-runner.mjs');
  assert.match(runner, /function toolsFor\(profile\)[\s\S]*availableToolDefinitions\(\)/);
  assert.match(runner, /subagentToolNames\(profile\?\.name\)/);
});
