/**
 * Contract tests for the boundary between what the runtime can execute and what
 * the model is actually told about.
 *
 * Each test here pins an invariant that was violated in production code and was
 * invisible to the existing suite, because every other test drives the runtime
 * through the in-repo fixture provider, which names tools directly instead of
 * choosing them from an advertised schema.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Loading the tool surface pulls in the sandbox and the store, and the store
// opens the database as a side effect of being imported. Point the data
// directory at a scratch location before those modules load, so a contract test
// never touches the developer's database. Static imports are hoisted, so the
// runtime modules have to be imported dynamically for this to take effect.
process.env.Z_AGENT_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'z-tool-surface-'));

const { TOOL_DEFINITIONS, availableToolDefinitions, mutatesWorkspace, requiresPermission } = await import('../server/native/tools.mjs');
const { subagentKinds, subagentToolNames } = await import('../server/native/subagents.mjs');
const { emitText } = await import('../server/native/agent/message-parts.mjs');
const { observeTurnSummary, prometheusMetrics, resetMetricsForTests } = await import('../server/native/metrics.mjs');

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
const advertised = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));

/* ----------------------- advertised surface contract ---------------------- */

test('every tool the dispatcher can execute is advertised to the model', () => {
  const dispatcher = read('server/native/tools/dispatcher.mjs');
  const handled = [...new Set([...dispatcher.matchAll(/tool === '([a-z_]+)'/g)].map((match) => match[1]))];
  assert.ok(handled.length > 10, 'dispatcher branch scan matched almost nothing - the scan pattern is stale');
  const missing = handled.filter((name) => !advertised.has(name));
  assert.deepEqual(missing, [], `the runtime can execute tools the provider is never told about: ${missing.join(', ')}`);
});

test('the question tool is advertised with the schema the runtime and UI consume', () => {
  const question = TOOL_DEFINITIONS.find((tool) => tool.name === 'question');
  assert.ok(question, 'without an advertised schema no real provider can ever ask the user a question');

  assert.deepEqual(question.inputSchema.required, ['questions']);
  const item = question.inputSchema.properties.questions.items;
  assert.deepEqual(item.required, ['question']);
  for (const field of ['question', 'header', 'options', 'allowCustomResponse']) {
    assert.ok(item.properties[field], `the question card reads ${field} from the tool payload`);
  }
  assert.ok(item.properties.options.items.properties.label, 'clickable answers are {label} records');

  // Asking a question mutates nothing and needs no approval prompt, and it must
  // survive every runtime-capability filter: a runtime that cannot ask is stuck.
  assert.equal(requiresPermission('question'), false);
  assert.equal(mutatesWorkspace('question'), false);
  assert.ok(availableToolDefinitions().some((tool) => tool.name === 'question'));
});

test('subagents still cannot reach the user through the question tool', () => {
  for (const role of subagentKinds()) {
    assert.ok(!subagentToolNames(role).includes('question'), `subagent ${role} must not interrupt the user`);
    assert.ok(!subagentToolNames(role).includes('task'), `subagent ${role} must not delegate recursively`);
  }
});

/* ------------------------- single-writer persistence ---------------------- */

test('only the store opens a SQLite handle inside the long-lived server process', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.mjs')) continue;
      if (!fs.readFileSync(full, 'utf8').includes('new DatabaseSync(')) continue;
      offenders.push(path.relative(repoRoot, full).split(path.sep).join('/'));
    }
  };
  walk(path.join(repoRoot, 'server/native'));

  // Two handles on one file are two connections with independent locks and
  // transaction state: BEGIN IMMEDIATE on one can fail the other with
  // SQLITE_BUSY. Short-lived CLI entrypoints under server/ are separate
  // processes and are deliberately out of scope here.
  assert.deepEqual(offenders, ['server/native/store/db.mjs']);
});

test('a streamed text part is persisted once, not once per character', async () => {
  const assistant = { id: 'msg_stream', sessionID: 'ses_stream', parts: [] };
  const text = 'x'.repeat(2000);
  let writes = 0;
  const events = [];

  await emitText(assistant, text, 'text', {
    putMessage: () => { writes += 1; },
    emit: (_sessionId, type) => { events.push(type); },
  });

  assert.equal(writes, 1, 'persisting per character turns one answer into thousands of synchronous writes');
  assert.deepEqual(events, ['message.part.updated']);
  assert.equal(assistant.parts.at(-1).text, text);
});

/* ---------------------------- metric cardinality --------------------------- */

test('a tool name invented by the model cannot create a new metrics series', () => {
  resetMetricsForTests();
  try {
    observeTurnSummary({
      outcome: 'completed',
      tools: {
        read: { calls: 1, errors: 0 },
        // Shaped like a real identifier, so a shape-only check accepts it. An
        // unknown tool still reaches telemetry, because the dispatcher turns it
        // into a failed tool result instead of aborting the turn.
        definitely_not_a_real_tool: { calls: 3, errors: 3 },
      },
    });
    const text = prometheusMetrics();
    assert.match(text, /z_agent_tool_calls_by_tool_total\{tool="read"\} 1/);
    assert.match(text, /z_agent_tool_calls_by_tool_total\{tool="other"\} 3/);
    assert.ok(
      !text.includes('definitely_not_a_real_tool'),
      'a model-supplied tool name must not become a permanent Prometheus label value',
    );
  } finally {
    resetMetricsForTests();
  }
});

/* -------------------------- session teardown contract ---------------------- */

test('deleting a session releases every per-session cache', () => {
  const route = read('server/routes/sessions.mjs');
  const start = route.indexOf("req.method === 'DELETE'");
  assert.ok(start > 0, 'delete-session branch scan is stale');
  const end = route.indexOf('sendJson(res, 204, null)', start);
  assert.ok(end > start, 'delete-session branch scan is stale');
  const branch = route.slice(start, end);

  // Every cache keyed by session id has to be released here. One that outlives
  // the deleted workspace directory leaks for the lifetime of the process.
  for (const call of [
    'killSandboxProcesses',
    'closeWorkspaceWatcher',
    'deleteChat',
    'revokePreviewTokens',
    'clearAgentSessionState',
    'clearSessionEvents',
    'forgetPreparedSandbox',
  ]) {
    assert.ok(branch.includes(`${call}(`), `deleting a session must call ${call}`);
  }
});

/* ----------------------- live progress for slow tools ---------------------- */

test('git reports progress while it runs, not only after it finishes', async () => {
  const { executeGitTool } = await import('../server/native/git-tool.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-git-live-'));
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n');

  const chunks = [];
  const result = await executeGitTool({
    root,
    identity: { isolated: false },
    input: { action: 'status' },
    onOutput: (stdout, stderr) => {
      chunks.push(`${stdout ?? ''}${stderr ?? ''}`);
    },
  });

  // ssh_tool carried this exact callback for a long time and nothing ever
  // passed it, so the tool card stayed empty until the command ended. Assert
  // the callback is actually reached, not merely accepted by the signature.
  assert.ok(chunks.length > 0, 'git must report output while the command is still running');
  assert.match(chunks.join(''), /tracked\.txt/);
  assert.ok(result.output, 'streaming must not replace the final tool result');
});

test('every tool that can report progress is wired to the live output channel', () => {
  const dispatcher = read('server/native/tools/dispatcher.mjs');

  // These two spawn long-running children directly instead of going through
  // execBash, so each one needs the wiring done by hand.
  for (const tool of ['git', 'ssh_tool']) {
    const start = dispatcher.indexOf(`tool === '${tool}'`);
    assert.ok(start > 0, `dispatch branch for ${tool} is stale`);
    const branch = dispatcher.slice(start, start + 1200);
    assert.ok(
      branch.includes('createLiveOutput(ctx?.onOutput)'),
      `${tool} must coalesce progress instead of emitting one SSE event per chunk`,
    );
    assert.ok(branch.includes('onOutput:'), `${tool} must pass onOutput down to its executor`);
    assert.ok(branch.includes('live.stop()'), `${tool} must stop the live buffer when it finishes`);
  }

  // Everything else that streams inherits it by forwarding ctx into execBash.
  // Dropping ctx there silently costs the tool its live output.
  for (const [file, label] of [
    ['server/native/tools/diagnostics.mjs', 'run_tests and diagnostics'],
    ['server/native/tools/environment.mjs', 'ensure_environment'],
    ['server/native/tools/media.mjs', 'media tools'],
  ]) {
    assert.ok(
      read(file).includes('ctx.signal, ctx)'),
      `${label} must forward ctx to execBash or the card shows nothing until the end`,
    );
  }
});
