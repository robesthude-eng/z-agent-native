import { TOOL_DEFINITIONS } from './tools/definitions.mjs';

// The tool name in this label comes from the model's tool call, so it is
// untrusted input. Validating only the shape of the string let any invented
// name that looked like an identifier become a permanent new Prometheus
// series: an unknown tool does not abort the turn, the dispatcher turns it into
// a failed tool result that is still recorded. Bucket anything outside the real
// tool surface so label cardinality stays bounded by the tool set.
const KNOWN_TOOL_NAMES = new Set(TOOL_DEFINITIONS.map((definition) => definition.name));

const counters = new Map();
const startedAt = Date.now();

function key(name, labels = {}) {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return `${name}|${entries.map(([k, v]) => `${k}=${String(v)}`).join(',')}`;
}

function inc(name, value = 1, labels = {}) {
  const k = key(name, labels);
  counters.set(k, (counters.get(k) || 0) + Number(value || 0));
}

function esc(value) {
  return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function metricLine(name, value, labels = {}) {
  const pairs = Object.entries(labels);
  const labelText = pairs.length ? `{${pairs.map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : '';
  return `${name}${labelText} ${Number.isFinite(Number(value)) ? Number(value) : 0}`;
}

function splitKey(raw) {
  const [name, rest = ''] = raw.split('|', 2);
  const labels = {};
  if (rest) for (const item of rest.split(',')) {
    const at = item.indexOf('=');
    if (at > 0) labels[item.slice(0, at)] = item.slice(at + 1);
  }
  return { name, labels };
}

function residentMemoryBytes() {
  try {
    return process.memoryUsage().rss;
  } catch {
    // Some restricted runtimes deliberately hide /proc. Metrics must remain
    // scrapeable even when the optional process RSS gauge is unavailable.
    return 0;
  }
}

export function observeTurnSummary(summary) {
  if (!summary) return;
  const outcome = ['completed', 'partial', 'failed', 'cancelled'].includes(String(summary.outcome)) ? String(summary.outcome) : 'unknown';
  inc('z_agent_turns_total', 1, { outcome });
  inc('z_agent_model_calls_total', summary.modelCalls);
  inc('z_agent_model_fallback_attempts_total', summary.fallbackAttempts);
  inc('z_agent_tool_calls_total', summary.toolCalls);
  inc('z_agent_tool_errors_total', summary.toolErrors);
  inc('z_agent_tool_retries_total', summary.toolRetries);
  inc('z_agent_tokens_total', summary?.tokens?.input, { direction: 'input' });
  inc('z_agent_tokens_total', summary?.tokens?.output, { direction: 'output' });
  inc('z_agent_turn_duration_seconds_sum', Number(summary.durationMs || 0) / 1000);
  inc('z_agent_turn_duration_seconds_count', 1);
  inc('z_agent_model_latency_seconds_sum', Number(summary.modelLatencyMs || 0) / 1000);
  inc('z_agent_model_latency_seconds_count', Number(summary.modelCalls || 0));
  inc('z_agent_tool_latency_seconds_sum', Number(summary.toolLatencyMs || 0) / 1000);
  inc('z_agent_tool_latency_seconds_count', Number(summary.toolCalls || 0));
  inc('z_agent_verification_attempts_total', summary.verificationAttempts);
  inc('z_agent_completion_gate_reminders_total', summary.gateReminders);
  for (const [tool, data] of Object.entries(summary.tools || {})) {
    const safeTool = KNOWN_TOOL_NAMES.has(tool) ? tool : 'other';
    inc('z_agent_tool_calls_by_tool_total', data?.calls, { tool: safeTool });
    inc('z_agent_tool_errors_by_tool_total', data?.errors, { tool: safeTool });
  }
}

export function recordTurnCapacityRejection(reason = 'unknown') {
  const safe = ['owner_limit', 'global_limit'].includes(String(reason)) ? String(reason) : 'unknown';
  inc('z_agent_turn_capacity_rejections_total', 1, { reason: safe });
}

export function prometheusMetrics({ activeTurns = 0 } = {}) {
  const lines = [
    '# HELP z_agent_info Static runtime information.',
    '# TYPE z_agent_info gauge',
    metricLine('z_agent_info', 1, { runtime: 'z-agent-native' }),
    '# HELP z_agent_uptime_seconds Process uptime.',
    '# TYPE z_agent_uptime_seconds gauge',
    metricLine('z_agent_uptime_seconds', (Date.now() - startedAt) / 1000),
    '# HELP z_agent_active_turns Current active agent turns in this process.',
    '# TYPE z_agent_active_turns gauge',
    metricLine('z_agent_active_turns', activeTurns),
    '# HELP z_agent_process_resident_memory_bytes Node resident memory.',
    '# TYPE z_agent_process_resident_memory_bytes gauge',
    metricLine('z_agent_process_resident_memory_bytes', residentMemoryBytes()),
  ];
  const entries = [...counters.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [raw, value] of entries) {
    const { name, labels } = splitKey(raw);
    lines.push(metricLine(name, value, labels));
  }
  return `${lines.join('\n')}\n`;
}

export function resetMetricsForTests() { counters.clear(); }
