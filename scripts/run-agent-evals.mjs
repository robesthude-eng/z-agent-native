import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'evals/coding-agent.json'), 'utf8'));

function argsMap(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i += 1; }
  }
  return out;
}

function parseModel(value) {
  const text = String(value || '').trim();
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) throw new Error('Pass --model provider/model (or Z_AGENT_EVAL_MODEL)');
  return { providerID: text.slice(0, slash), modelID: text.slice(slash + 1) };
}

function safeSessionId(id) {
  return `ses_eval${crypto.createHash('sha256').update(`${id}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 20)}`;
}

const COPY_IGNORES = new Set(['.git', 'node_modules', 'dist', 'data', 'workspaces', '.e2e-tmp', 'playwright-report', 'coverage']);
function copyWorkspace(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    filter(src) {
      const rel = path.relative(source, src);
      if (!rel) return true;
      return !rel.split(path.sep).some((part) => COPY_IGNORES.has(part));
    },
  });
}

function treeHash(rootDir) {
  const hash = crypto.createHash('sha256');
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (COPY_IGNORES.has(entry.name) || entry.name === '.agent-home') continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(rootDir, full).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) { hash.update(`L\0${rel}\0${fs.readlinkSync(full)}\0`); continue; }
      if (entry.isDirectory()) { hash.update(`D\0${rel}\0`); walk(full); continue; }
      if (!entry.isFile()) continue;
      hash.update(`F\0${rel}\0`);
      hash.update(fs.readFileSync(full));
      hash.update('\0');
    }
  };
  walk(rootDir);
  return hash.digest('hex');
}

function finalText(message) {
  return (message?.parts || []).filter((part) => part?.type === 'text').map((part) => String(part.text || '')).join('\n').trim();
}

function toolEvidence(message) {
  return (message?.parts || []).filter((part) => part?.type === 'tool').map((part) => ({
    tool: String(part.tool || ''),
    status: String(part.state?.status || ''),
    isError: String(part.state?.status || '') === 'error',
    input: part.state?.input || {},
    output: String(part.state?.output || '').slice(0, 500),
  }));
}

function commandCheck(command, cwd) {
  if (!command) return { configured: false, ok: true, output: '' };
  try {
    const output = execFileSync('/bin/bash', ['--noprofile', '--norc', '-c', command], { cwd, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
    return { configured: true, ok: true, output: String(output || '').slice(-3000) };
  } catch (err) {
    const output = `${err?.stdout || ''}\n${err?.stderr || ''}`.trim();
    return { configured: true, ok: false, output: output.slice(-3000), exit: err?.status ?? null };
  }
}

function scoreCase(item, { text, tools, beforeHash, afterHash, workspace, outcome }) {
  const lower = text.toLowerCase();
  const pathHits = item.mustMentionPaths.map((value) => lower.includes(String(value).toLowerCase()));
  const anyHits = item.mustMentionAny.map((value) => lower.includes(String(value).toLowerCase()));
  const fileChecks = (item.expectFiles || []).map((expected) => {
    const full = path.join(workspace, expected.path);
    const exists = fs.existsSync(full) && fs.statSync(full).isFile();
    const content = exists ? fs.readFileSync(full, 'utf8') : '';
    return { path: expected.path, ok: exists && (expected.contains == null || content.includes(expected.contains)), contains: expected.contains || null };
  });
  const verify = commandCheck(item.verifyCommand, workspace);
  const mutated = beforeHash !== afterHash;
  const requiresMutation = !item.forbidMutation && String(item.agent || '') === 'implement';
  const mutationOk = item.forbidMutation ? !mutated : (requiresMutation ? mutated : true);
  const toolErrors = tools.filter((tool) => tool.isError).length;
  const delegated = tools.some((tool) => tool.tool === 'task' && String(tool.input?.agent || '').toLowerCase() === String(item.agent || '').toLowerCase());

  const criteria = [
    { name: 'final_mentions_paths', weight: 25, ok: pathHits.every(Boolean), detail: `${pathHits.filter(Boolean).length}/${pathHits.length}` },
    { name: 'final_mentions_signal', weight: 15, ok: anyHits.some(Boolean), detail: `${anyHits.filter(Boolean).length}/${anyHits.length}` },
    { name: 'turn_completed', weight: 15, ok: String(outcome || '') === 'completed', detail: String(outcome || '') },
    { name: 'specialized_worker', weight: 10, ok: item.ciSmoke ? true : delegated, detail: item.ciSmoke ? 'fixture smoke' : (delegated ? item.agent : 'missing') },
    { name: 'tool_errors', weight: 10, ok: toolErrors === 0, detail: String(toolErrors) },
    { name: 'mutation_policy', weight: 10, ok: mutationOk, detail: mutated ? 'mutated' : 'unchanged' },
    { name: 'expected_files', weight: 10, ok: fileChecks.length === 0 || fileChecks.every((check) => check.ok), detail: fileChecks.map((check) => `${check.path}:${check.ok ? 'ok' : 'fail'}`).join(',') || 'n/a' },
    { name: 'external_verification', weight: 15, ok: verify.ok, detail: verify.configured ? (verify.ok ? 'pass' : `fail:${verify.exit ?? '?'}`) : 'n/a' },
  ];
  const applicable = criteria.filter((criterion) => {
    if (criterion.name === 'expected_files' && fileChecks.length === 0) return false;
    if (criterion.name === 'external_verification' && !verify.configured) return false;
    return true;
  });
  const totalWeight = applicable.reduce((sum, item) => sum + item.weight, 0);
  const earned = applicable.reduce((sum, item) => sum + (item.ok ? item.weight : 0), 0);
  return {
    score: totalWeight ? Math.round((earned / totalWeight) * 100) : 0,
    criteria: applicable,
    mutated,
    fileChecks,
    verify,
    toolErrors,
  };
}

const cli = argsMap(process.argv.slice(2));
const smoke = Boolean(cli.smoke);
if (smoke) process.env.Z_AGENT_ENABLE_FIXTURE_PROVIDER = '1';
const model = parseModel(smoke ? 'fixture/coding-e2e' : (cli.model || process.env.Z_AGENT_EVAL_MODEL || process.env.Z_AGENT_DEFAULT_MODEL));
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-evals-'));
// When evals run as root (CI/container), test tools drop to the per-session UID.
// Keep the temp parent traversable so the sandbox can reach its owned workspace.
fs.chmodSync(tempRoot, 0o755);
process.env.Z_AGENT_DATA_DIR = path.join(tempRoot, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(tempRoot, 'workspaces');
process.env.Z_AGENT_TELEMETRY_FILE = path.join(tempRoot, 'eval-telemetry.jsonl');

const store = await import('../server/native/store.mjs');
const { prepareWorkspaceSandbox } = await import('../server/native/sandbox.mjs');
const { runTurn, resetAgentStateForTests } = await import('../server/native/agent.mjs');
const providerConfigs = await import('../server/native/provider-configs.mjs');

const ownerId = String(cli.owner || 'eval-runner@local.invalid');
if (!store.getUser(ownerId)) store.createUser(ownerId, 'eval-runner-no-login');
if (!smoke) {
  const protocol = String(cli.protocol || process.env.Z_AGENT_EVAL_PROTOCOL || 'openai');
  const baseURL = String(cli['base-url'] || process.env.Z_AGENT_EVAL_BASE_URL || '').trim();
  const key = String(cli['api-key'] || process.env.Z_AGENT_EVAL_API_KEY || '').trim();
  if (!baseURL || !key) throw new Error('Real evals need --base-url and --api-key (or Z_AGENT_EVAL_BASE_URL/Z_AGENT_EVAL_API_KEY) for the isolated eval runtime.');
  providerConfigs.upsertProviderConfig(ownerId, { id: model.providerID, name: `Eval ${model.providerID}`, protocol, baseURL, enabled: true });
  store.setProviderKey(ownerId, model.providerID, key);
}

let cases = manifest.cases.filter((item) => smoke ? item.ciSmoke : !item.ciSmoke);
if (cli.case) cases = cases.filter((item) => item.id === cli.case);
if (cli.limit) cases = cases.slice(0, Math.max(1, Number(cli.limit) || 1));
if (!cases.length) throw new Error('No eval cases selected');

const results = [];
for (const [index, item] of cases.entries()) {
  const sid = safeSessionId(item.id);
  store.createChat(sid, ownerId, `Eval: ${item.id}`);
  const workspace = store.workspaceFor(sid);
  const source = path.resolve(root, item.workspacePath || '.');
  copyWorkspace(source, workspace);
  prepareWorkspaceSandbox(sid, workspace);
  const beforeHash = treeHash(workspace);
  const startedAt = Date.now();
  let message = null;
  let thrown = null;
  try {
    message = await runTurn({
      sessionId: sid,
      ownerId,
      parts: [{ type: 'text', text: item.prompt }],
      model,
      system: item.ciSmoke ? '' : `Evaluation constraint: use task(agent="${item.agent}") as the primary specialized worker for this task. Base the final answer on repository evidence and cite concrete relative paths.`,
    });
  } catch (err) {
    thrown = err;
    message = store.listMessages(sid).filter((entry) => entry.role === 'assistant').at(-1) || null;
  }
  const afterHash = treeHash(workspace);
  const text = finalText(message);
  const tools = toolEvidence(message);
  const scoring = scoreCase(item, { text, tools, beforeHash, afterHash, workspace, outcome: message?.info?.outcome?.status || (thrown ? 'failed' : '') });
  const result = {
    id: item.id,
    agent: item.agent,
    score: scoring.score,
    durationMs: Date.now() - startedAt,
    outcome: message?.info?.outcome || null,
    error: thrown ? String(thrown?.message || thrown) : '',
    text,
    tools,
    telemetry: message?.info?.telemetry || null,
    ...scoring,
  };
  results.push(result);
  console.log(`[${index + 1}/${cases.length}] ${item.id}: ${result.score} ${result.error ? `ERROR ${result.error}` : ''}`.trim());
  resetAgentStateForTests();
}

const report = {
  version: 2,
  generatedAt: new Date().toISOString(),
  model: `${model.providerID}/${model.modelID}`,
  smoke,
  caseCount: results.length,
  averageScore: Math.round(results.reduce((sum, item) => sum + item.score, 0) / results.length),
  passed: results.filter((item) => item.score >= 80 && !item.error).length,
  results,
};

if (cli.baseline) {
  const baselineFile = path.resolve(String(cli.baseline));
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const priorById = new Map((baseline.results || []).map((item) => [item.id, item]));
  const compared = results.flatMap((item) => {
    const prior = priorById.get(item.id);
    if (!prior || !Number.isFinite(Number(prior.score))) return [];
    const baselineScore = Number(prior.score);
    return [{ id: item.id, baselineScore, score: item.score, delta: item.score - baselineScore }];
  });
  const tolerance = Math.max(0, Number(cli['regression-tolerance'] ?? 5) || 0);
  const regressions = compared.filter((item) => item.delta < -tolerance);
  report.comparison = {
    baselineFile,
    baselineModel: baseline.model || null,
    matchedCases: compared.length,
    regressionTolerance: tolerance,
    averageDelta: compared.length ? Number((compared.reduce((sum, item) => sum + item.delta, 0) / compared.length).toFixed(2)) : null,
    improved: compared.filter((item) => item.delta > tolerance).length,
    unchanged: compared.filter((item) => Math.abs(item.delta) <= tolerance).length,
    regressed: regressions.length,
    cases: compared,
  };
  console.log(`Baseline comparison: ${compared.length} matched, ${report.comparison.improved} improved, ${report.comparison.regressed} regressed beyond ${tolerance} points, avg delta ${report.comparison.averageDelta ?? 'n/a'}`);
  if (cli['fail-on-regression'] && regressions.length) process.exitCode = 1;
}

const output = path.resolve(cli.output || path.join(root, 'evals', smoke ? 'latest-smoke-report.json' : 'latest-report.json'));
fs.writeFileSync(output, JSON.stringify(report, null, 2));
console.log(`Eval score: ${report.averageScore}/100; pass>=80: ${report.passed}/${report.caseCount}`);
console.log(`Report: ${output}`);

if (!cli.keep) fs.rmSync(tempRoot, { recursive: true, force: true });
if (report.passed !== report.caseCount) process.exitCode = 1;
