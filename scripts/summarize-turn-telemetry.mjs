import fs from 'node:fs';
import path from 'node:path';

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

const dataDir = path.resolve(process.env.Z_AGENT_DATA_DIR || './data');
const file = path.resolve(argValue('--file') || process.env.Z_AGENT_TELEMETRY_FILE || path.join(dataDir, 'turn-telemetry.jsonl'));
const last = Math.max(1, Math.min(100_000, Number(argValue('--last')) || 1_000));

if (!fs.existsSync(file)) {
  console.error(`Telemetry file not found: ${file}`);
  process.exit(1);
}

const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-last).map((line, index) => {
  try { return JSON.parse(line); } catch { throw new Error(`Invalid telemetry JSONL near selected row ${index + 1}`); }
});

const sum = (key) => rows.reduce((total, row) => total + Number(row?.[key] || 0), 0);
const outcomes = {};
const models = {};
const tools = {};
for (const row of rows) {
  const outcome = String(row.outcome || 'unknown');
  outcomes[outcome] = (outcomes[outcome] || 0) + 1;
  const model = String(row.model || 'unknown');
  models[model] = (models[model] || 0) + 1;
  for (const [name, item] of Object.entries(row.tools || {})) {
    const target = tools[name] || { calls: 0, errors: 0, latencyMs: 0 };
    target.calls += Number(item?.calls || 0);
    target.errors += Number(item?.errors || 0);
    target.latencyMs += Number(item?.latencyMs || 0);
    tools[name] = target;
  }
}
const pct = (value, total) => total ? Math.round((value / total) * 1000) / 10 : 0;
const average = (value) => rows.length ? Math.round(value / rows.length) : 0;
const completed = outcomes.completed || 0;
const summary = {
  file,
  turns: rows.length,
  successRatePct: pct(completed, rows.length),
  outcomes,
  averages: {
    durationMs: average(sum('durationMs')),
    modelCalls: average(sum('modelCalls')),
    toolCalls: average(sum('toolCalls')),
    toolErrors: average(sum('toolErrors')),
    gateReminders: average(sum('gateReminders')),
    verificationAttempts: average(sum('verificationAttempts')),
    inputTokens: average(rows.reduce((n, row) => n + Number(row?.tokens?.input || 0), 0)),
    outputTokens: average(rows.reduce((n, row) => n + Number(row?.tokens?.output || 0), 0)),
  },
  fallbackAttempts: sum('fallbackAttempts'),
  toolRetries: sum('toolRetries'),
  estimatedCostUsd: Math.round(rows.reduce((n, row) => n + Number(row?.estimatedCostUsd || 0), 0) * 1e8) / 1e8,
  models,
  tools: Object.fromEntries(Object.entries(tools).sort((a, b) => b[1].calls - a[1].calls)),
};

console.log(JSON.stringify(summary, null, 2));
