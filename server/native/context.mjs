import { shellSandboxAvailable } from './sandbox.mjs';

const DEFAULT_CONTEXT_CHARS = 360_000;
const DEFAULT_TOOL_OBSERVATION_CHARS = 32_000;
const MIN_CONTEXT_CHARS = 24_000;

function frameWeight(frame) {
  let n = String(frame?.content || '').length;
  for (const media of frame?.media || []) n += Math.min(String(media?.dataUrl || '').length, 250_000);
  for (const call of frame?.toolCalls || []) n += JSON.stringify(call?.arguments || {}).length + 256;
  return n;
}

function clipMiddle(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  const marker = `\n\n[observation compacted: ${text.length - maxChars} chars omitted]\n\n`;
  const remaining = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(remaining * 0.7);
  const tail = remaining - head;
  return `${text.slice(0, head)}${marker}${tail ? text.slice(-tail) : ''}`;
}

function compactObservation(frame, maxChars) {
  if (frame?.role !== 'tool') return frame;
  return { ...frame, content: clipMiddle(frame.content, maxChars) };
}

function isDanglingTool(frames, index) {
  if (frames[index]?.role !== 'tool') return false;
  for (let i = index - 1; i >= 0; i--) {
    if (frames[i]?.role === 'tool') continue;
    return frames[i]?.role !== 'assistant' || !(frames[i]?.toolCalls || []).some((call) => call.id === frames[index].callId);
  }
  return true;
}

function makeToolPairsCoherent(frames) {
  const resultIds = new Set(frames.filter((frame) => frame?.role === 'tool' && frame.callId).map((frame) => frame.callId));
  const out = [];
  for (const frame of frames) {
    if (frame?.role !== 'assistant' || !frame.toolCalls?.length) {
      out.push(frame);
      continue;
    }
    const toolCalls = frame.toolCalls.filter((call) => resultIds.has(call.id));
    if (frame.content || toolCalls.length) out.push({ ...frame, toolCalls });
  }
  return out;
}

/**
 * Bound provider context on every model step, not only when a turn starts.
 * Tool observations are compacted independently before oldest context is
 * dropped. Provider tool-call/result coherence is preserved.
 */
export function compactFrames(input, options = {}) {
  const maxChars = Math.max(MIN_CONTEXT_CHARS, Number(options.maxChars || process.env.Z_AGENT_CONTEXT_CHARS) || DEFAULT_CONTEXT_CHARS);
  const maxObservationChars = Math.max(4_000, Number(options.maxObservationChars || process.env.Z_AGENT_TOOL_OBSERVATION_CHARS) || DEFAULT_TOOL_OBSERVATION_CHARS);
  const frames = (Array.isArray(input) ? input : []).map((frame) => compactObservation(frame, maxObservationChars));
  const weight = frames.reduce((sum, frame) => sum + frameWeight(frame), 0);
  if (weight <= maxChars) return makeToolPairsCoherent(frames);

  const keep = new Array(frames.length).fill(false);
  let used = 0;
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];
    const w = frameWeight(frame);
    // Skip only the frames that do not fit. Stopping here dropped every older
    // frame because of one oversized observation in the middle of the history.
    if (used > 0 && used + w > maxChars) continue;
    keep[i] = true;
    used += w;
  }

  // A retained tool result must keep the assistant frame that introduced its
  // call. Calls whose results were dropped are filtered out below.
  for (let i = 0; i < frames.length; i++) {
    if (!keep[i] || frames[i]?.role !== 'tool') continue;
    for (let j = i - 1; j >= 0; j--) {
      if (frames[j]?.role === 'tool') continue;
      if (frames[j]?.role === 'assistant' && (frames[j]?.toolCalls || []).some((call) => call.id === frames[i].callId)) keep[j] = true;
      break;
    }
  }

  let out = makeToolPairsCoherent(frames.filter((_, i) => keep[i]));
  while (out.length && isDanglingTool(out, 0)) out.shift();
  out = makeToolPairsCoherent(out);
  return out;
}

const VERIFY_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|lint|typecheck|check|build))\b/i,
  /\b(?:pytest|python\s+-m\s+pytest|go\s+test|cargo\s+(?:test|check)|mvn\s+test|gradle\s+test|\.\/gradlew\s+test)\b/i,
  /\b(?:tsc\b|eslint\b|biome\s+check\b|ruff\s+check\b|mypy\b)/i,
  /\bnode\s+--check\b/i,
  /\bpython3?\s+-m\s+(?:compileall|json\.tool)\b/i,
];

const READ_ONLY_BASH_PATTERNS = [
  /^\s*(?:pwd|ls\b|find\b|cat\b|head\b|tail\b|sed\s+-n\b|grep\b|rg\b)/i,
  /^\s*git\s+(?:status|diff|log|show|branch|rev-parse)\b/i,
  /^\s*(?:node|python|python3)\s+--version\b/i,
];

/** Split a command line into the individual commands it will actually run. */
function bashSegments(text) {
  return String(text || '')
    .split(/\|\||&&|[|;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function classifyBash(command) {
  const text = String(command || '').trim();
  if (!text) return 'read_only';
  if (VERIFY_PATTERNS.some((rx) => rx.test(text))) return 'verification';
  // Redirections and command substitution can write no matter which command runs.
  if (/>/.test(text) || /\$\(|`/.test(text)) return 'may_mutate';
  // Every stage of a pipeline must be read-only, so `git log | grep x` stays
  // read-only while `cat a | tee b` does not.
  const segments = bashSegments(text);
  if (!segments.length) return 'read_only';
  return segments.every((segment) => READ_ONLY_BASH_PATTERNS.some((rx) => rx.test(segment))) ? 'read_only' : 'may_mutate';
}

export function createTurnStrategy(goal = '') {
  return {
    goal: String(goal || '').trim().slice(0, 8_000),
    plan: [],
    changed: false,
    needsVerification: false,
    verificationAttempts: 0,
    lastVerificationOk: null,
    toolErrors: 0,
  };
}

export function observeTool(strategy, call, result) {
  const state = strategy;
  const name = String(call?.name || '').toLowerCase();
  if (result?.isError) state.toolErrors += 1;

  if (name === 'todowrite' && Array.isArray(result?.metadata?.todos)) {
    state.plan = result.metadata.todos.slice(0, 30).map((todo) => ({
      content: String(todo?.content || '').slice(0, 500),
      status: String(todo?.status || 'pending'),
      priority: String(todo?.priority || 'medium'),
    }));
    return state;
  }

  if (['write', 'edit', 'apply_patch'].includes(name)) {
    if (!result?.isError) {
      state.changed = true;
      state.needsVerification = true;
      state.lastVerificationOk = null;
    }
    return state;
  }

  if (name === 'bash') {
    const effect = classifyBash(call?.arguments?.command);
    if (effect === 'verification') {
      state.verificationAttempts += 1;
      const exit = Number(result?.metadata?.exit);
      const ok = !result?.isError && (!Number.isFinite(exit) || exit === 0);
      state.lastVerificationOk = ok;
      if (ok) state.needsVerification = false;
      return state;
    }
    if (effect === 'may_mutate' && !result?.isError) {
      state.changed = true;
      state.needsVerification = true;
      state.lastVerificationOk = null;
    }
  }
  return state;
}

export function completionGate(strategy) {
  if (!strategy?.needsVerification) return null;
  if (!shellSandboxAvailable()) {
    // No shell means verification is impossible, not that the change is proven.
    // Degrade to a mandatory read-back instead of silently dropping the gate.
    return [
      '[Runtime completion gate]',
      'The workspace changed and no executable verification is available in this runtime (no shell sandbox).',
      'Do not finish yet. Re-read every file you changed, confirm the edit is complete and internally consistent, and state in the final answer that automated verification was unavailable.',
    ].join('\n');
  }
  return [
    '[Runtime completion gate]',
    'The workspace may have changed, but no successful verification has happened after the latest change.',
    'Do not finish yet. Inspect the resulting diff/state and run the most relevant available test, build, typecheck, lint, syntax check, or another executable validation of the changed behavior.',
    'A read-only command such as git diff/status is useful inspection but does not by itself satisfy verification.',
    'If verification cannot be run, investigate why and explicitly report the limitation only after reasonable attempts.',
  ].join('\n');
}

export function strategyGuidance(strategy) {
  const lines = ['[Native turn strategy]'];
  if (strategy?.goal) lines.push(`Goal: ${strategy.goal}`);
  if (strategy?.plan?.length) {
    lines.push('Current plan:');
    for (const todo of strategy.plan.slice(0, 20)) lines.push(`- [${todo.status}] ${todo.content}`);
  }
  if (strategy?.needsVerification && shellSandboxAvailable()) lines.push('Workspace state: changed since the last successful executable verification; verification is required before completion.');
  else if (strategy?.needsVerification) lines.push('Workspace state: changed, but executable verification is unavailable in this runtime. Inspect the changed files with read/grep and report this verification limitation explicitly.');
  else if (strategy?.changed && strategy?.lastVerificationOk) lines.push('Workspace state: latest known changes have a successful verification signal.');
  return lines.join('\n');
}
