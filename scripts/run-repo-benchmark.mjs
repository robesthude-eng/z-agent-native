import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isPinnedCommit, resolveLocalBenchmarkSource, validateBenchmarkManifest } from './repo-benchmark-manifest.mjs';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const benchmarkSourceRoot = path.resolve(process.env.Z_AGENT_BENCHMARK_SOURCE_ROOT || repoRoot);
function argvMap(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2); const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true; else { out[key] = next; i += 1; }
  }
  return out;
}
function modelSpec(text) {
  const value = String(text || '').trim(); const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) throw new Error('Benchmark model must be provider/model');
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) };
}
function run(command, cwd, timeoutMs = 300_000, env = process.env) {
  try {
    return { ok: true, output: execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', command], { cwd, env, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] }).slice(-8000), exit: 0 };
  } catch (error) {
    return { ok: false, output: `${error?.stdout || ''}\n${error?.stderr || ''}`.trim().slice(-8000), exit: error?.status ?? 1 };
  }
}
function copySource(source, target) {
  if (source.type === 'local') {
    const from = resolveLocalBenchmarkSource(benchmarkSourceRoot, source.path);
    fs.cpSync(from, target, { recursive: true, filter: (src) => !['.git', 'node_modules', 'dist', 'coverage'].includes(path.basename(src)) });
    return { type: 'local', source: from };
  }
  if (source.type === 'git') {
    const url = String(source.url || ''); const ref = String(source.ref || '');
    if (!/^https:\/\//.test(url) || !isPinnedCommit(ref)) throw new Error('git benchmark sources require an HTTPS URL and a full pinned commit hash (40/64 hex chars)');
    execFileSync('git', ['clone', '--no-checkout', '--filter=blob:none', url, target], { stdio: 'inherit', timeout: 300_000 });
    execFileSync('git', ['-C', target, 'checkout', '--detach', ref], { stdio: 'inherit', timeout: 120_000 });
    const resolved = execFileSync('git', ['-C', target, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (resolved.toLowerCase() !== ref.toLowerCase()) throw new Error(`Pinned benchmark commit mismatch: requested=${ref} resolved=${resolved}`);
    return { type: 'git', url, ref, resolved };
  }
  throw new Error(`Unsupported source type: ${source.type}`);
}
function finalText(message) { return (message?.parts || []).filter((p) => p?.type === 'text').map((p) => String(p.text || '')).join('\n').trim(); }
function toolStats(message) {
  const parts = (message?.parts || []).filter((p) => p?.type === 'tool');
  return { calls: parts.length, errors: parts.filter((p) => p?.state?.status === 'error').length, names: parts.map((p) => p.tool) };
}

const cli = argvMap(process.argv.slice(2));
const manifestPath = path.resolve(cli.manifest || process.env.Z_AGENT_BENCHMARK_MANIFEST || path.join(repoRoot, 'evals/production-benchmark.example.json'));
const manifest = validateBenchmarkManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
const model = modelSpec(cli.model || process.env.Z_AGENT_EVAL_MODEL);
const repetitions = Math.min(Math.max(Number(cli.repetitions || process.env.Z_AGENT_BENCHMARK_REPETITIONS || 3), 1), 10);
const unsafeLocalExecutor = cli['unsafe-local-executor'] === true || process.env.Z_AGENT_BENCHMARK_UNSAFE_LOCAL_EXECUTOR === '1';
const configuredWorkspaces = String(process.env.Z_AGENT_WORKSPACES_DIR || '/workspaces');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-real-benchmark-')); fs.chmodSync(temp, 0o755);
process.env.Z_AGENT_DATA_DIR = path.join(temp, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = unsafeLocalExecutor ? path.join(temp, 'workspaces') : configuredWorkspaces;
process.env.Z_AGENT_NETWORK_POLICY = 'off';
process.env.Z_AGENT_EXECUTOR_REQUIRED = unsafeLocalExecutor ? '0' : '1';
if (unsafeLocalExecutor) process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';

const store = await import('../server/native/store.mjs');
const providerConfigs = await import('../server/native/provider-configs.mjs');
const { prepareWorkspaceSandbox } = await import('../server/native/sandbox.mjs');
const { executeInExecutor, executorAvailable } = await import('../server/native/executor-client.mjs');
const { runTurn, resetAgentStateForTests } = await import('../server/native/agent.mjs');
if (!unsafeLocalExecutor && !executorAvailable()) {
  throw new Error('Production benchmark requires the networkless executor socket. Run from an isolated benchmark deployment with Z_AGENT_EXECUTOR_SOCKET mounted, or use --unsafe-local-executor only for trusted local fixture development.');
}

async function sandboxCommand(command, workspace, sessionId, timeoutMs = 300_000) {
  if (unsafeLocalExecutor) return run(command, workspace, timeoutMs, {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: path.join(workspace, '.agent-home'), LANG: process.env.LANG || 'C.UTF-8',
  });
  const uid = store.getSandboxUid(sessionId);
  const result = await executeInExecutor({
    workspace, uid, gid: uid, file: '/bin/bash', args: ['--noprofile', '--norc', '-c', command], timeoutMs,
    env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: path.join(workspace, '.agent-home'), LANG: process.env.LANG || 'C.UTF-8' },
  });
  return { ok: Number(result?.code) === 0, output: `${result?.stdout || ''}
${result?.stderr || ''}`.trim().slice(-8000), exit: Number(result?.code) || 0 };
}
const ownerId = 'benchmark-runner@local.invalid';
if (!store.getUser(ownerId)) store.createUser(ownerId, 'no-login-benchmark');
const protocol = String(cli.protocol || process.env.Z_AGENT_EVAL_PROTOCOL || 'openai');
const baseURL = String(cli['base-url'] || process.env.Z_AGENT_EVAL_BASE_URL || '').trim();
const apiKey = String(cli['api-key'] || process.env.Z_AGENT_EVAL_API_KEY || '').trim();
if (!baseURL || !apiKey) throw new Error('Benchmark requires Z_AGENT_EVAL_BASE_URL and Z_AGENT_EVAL_API_KEY (or CLI equivalents)');
providerConfigs.upsertProviderConfig(ownerId, { id: model.providerID, name: `Benchmark ${model.providerID}`, protocol, baseURL, enabled: true });
store.setProviderKey(ownerId, model.providerID, apiKey);

let cases = manifest.cases;
if (cli.case) cases = cases.filter((c) => c.id === cli.case);
if (cli.limit) cases = cases.slice(0, Number(cli.limit));
const reportCases = [];
for (const [caseIndex, item] of cases.entries()) {
  const runs = [];
  for (let rep = 0; rep < repetitions; rep += 1) {
    const sid = `ses_bench${crypto.randomBytes(10).toString('hex')}`;
    store.createChat(sid, ownerId, `Benchmark ${item.id}`);
    const workspace = store.workspaceFor(sid);
    const sourceInfo = copySource(item.source, workspace);
    prepareWorkspaceSandbox(sid, workspace);
    if (item.setupCommand) {
      const setup = await sandboxCommand(item.setupCommand, workspace, sid, Number(item.setupTimeoutMs) || 300_000);
      if (!setup.ok) throw new Error(`Benchmark ${item.id} setup failed: ${setup.output}`);
    }
    const started = Date.now(); let message = null; let error = '';
    try {
      message = await runTurn({
        sessionId: sid, ownerId, parts: [{ type: 'text', text: String(item.prompt || '') }], model,
        system: 'Benchmark mode: solve the repository task autonomously. External web access is disabled. Inspect the repository, make the smallest correct change, and run relevant executable verification before finishing.',
      });
    } catch (err) {
      error = err?.message || String(err);
      message = store.listMessages(sid).filter((m) => m.role === 'assistant').at(-1) || null;
    }
    const verify = await sandboxCommand(String(item.verifyCommand || ''), workspace, sid, Number(item.verifyTimeoutMs) || 300_000);
    const regressions = [];
    for (const command of item.regressionCommands || []) regressions.push({ command, ...await sandboxCommand(command, workspace, sid, Number(item.verifyTimeoutMs) || 300_000) });
    const tools = toolStats(message);
    const durationMs = Date.now() - started;
    const withinBudget = durationMs <= Number(item.maxDurationMs || 1_800_000) && tools.calls <= Number(item.maxToolCalls || 128);
    const pass = !error && verify.ok && regressions.every((r) => r.ok) && withinBudget;
    runs.push({ repetition: rep + 1, pass, durationMs, error, outcome: message?.info?.outcome?.status || '', verify, regressions, tools, final: finalText(message).slice(0, 4000), source: sourceInfo });
    console.log(`[${caseIndex + 1}/${cases.length}] ${item.id} #${rep + 1}: ${pass ? 'PASS' : 'FAIL'} tools=${tools.calls} duration=${durationMs}ms`);
    resetAgentStateForTests();
    if (!cli.keep && !unsafeLocalExecutor) fs.rmSync(workspace, { recursive: true, force: true });
  }
  const passed = runs.filter((r) => r.pass).length;
  reportCases.push({
    id: item.id,
    passed,
    repetitions,
    passRate: passed / repetitions,
    meanDurationMs: Math.round(runs.reduce((sum, r) => sum + r.durationMs, 0) / runs.length),
    meanToolCalls: Number((runs.reduce((sum, r) => sum + Number(r.tools?.calls || 0), 0) / runs.length).toFixed(2)),
    runs,
  });
}
const totalRuns = reportCases.reduce((sum, c) => sum + c.repetitions, 0);
const passedRuns = reportCases.reduce((sum, c) => sum + c.passed, 0);
const minPassRate = Number(cli['min-pass-rate'] || process.env.Z_AGENT_BENCHMARK_MIN_PASS_RATE || 0.8);
const baselinePath = String(cli.baseline || process.env.Z_AGENT_BENCHMARK_BASELINE || '').trim();
const maxPassRateRegression = Math.min(Math.max(Number(cli['max-pass-rate-regression'] || process.env.Z_AGENT_BENCHMARK_MAX_PASS_RATE_REGRESSION || 0.1), 0), 1);
const maxToolRegression = Math.max(Number(cli['max-tool-regression'] || process.env.Z_AGENT_BENCHMARK_MAX_TOOL_REGRESSION || 0.25), 0);
const maxDurationRegression = Math.max(Number(cli['max-duration-regression'] || process.env.Z_AGENT_BENCHMARK_MAX_DURATION_REGRESSION || 0.35), 0);
const regressions = [];
let baseline = null;
if (baselinePath) {
  baseline = JSON.parse(fs.readFileSync(path.resolve(baselinePath), 'utf8'));
  const oldCases = new Map((baseline.cases || []).map((item) => [String(item.id), item]));
  for (const current of reportCases) {
    const old = oldCases.get(current.id);
    if (!old) continue;
    const passDrop = Number(old.passRate || 0) - current.passRate;
    if (passDrop > maxPassRateRegression + 1e-9) regressions.push({ id: current.id, metric: 'passRate', baseline: Number(old.passRate || 0), current: current.passRate, delta: -passDrop });
    const oldTools = Number(old.meanToolCalls || 0);
    if (oldTools > 0 && current.meanToolCalls > oldTools * (1 + maxToolRegression)) regressions.push({ id: current.id, metric: 'meanToolCalls', baseline: oldTools, current: current.meanToolCalls, ratio: current.meanToolCalls / oldTools });
    const oldDuration = Number(old.meanDurationMs || 0);
    if (oldDuration > 0 && current.meanDurationMs > oldDuration * (1 + maxDurationRegression)) regressions.push({ id: current.id, metric: 'meanDurationMs', baseline: oldDuration, current: current.meanDurationMs, ratio: current.meanDurationMs / oldDuration });
  }
}
const report = {
  version: 2, generatedAt: new Date().toISOString(), manifest: manifestPath, model: `${model.providerID}/${model.modelID}`,
  cases: reportCases, totalRuns, passedRuns, passRate: totalRuns ? passedRuns / totalRuns : 0,
  casePassRate: reportCases.length ? reportCases.filter((c) => c.passRate >= minPassRate).length / reportCases.length : 0,
  requiredPassRate: minPassRate,
  baseline: baselinePath ? { path: path.resolve(baselinePath), model: baseline?.model || '', regressions, tolerances: { maxPassRateRegression, maxToolRegression, maxDurationRegression } } : null,
};
const output = path.resolve(cli.output || path.join(repoRoot, 'evals/latest-production-benchmark.json'));
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(`Benchmark: ${(report.passRate * 100).toFixed(1)}% run pass rate; ${(report.casePassRate * 100).toFixed(1)}% cases meet >=${(minPassRate * 100).toFixed(0)}% stability`);
if (baselinePath) console.log(`Baseline regressions: ${regressions.length}`);
console.log(`Report: ${output}`);
if (report.passRate < minPassRate || report.casePassRate < minPassRate || regressions.length) process.exitCode = 1;
if (!cli.keep) fs.rmSync(temp, { recursive: true, force: true });
