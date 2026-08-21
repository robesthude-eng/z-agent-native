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
  /\bnode\s+--(?:check|test)\b/i,
  /\bpython3?\s+-m\s+(?:compileall|json\.tool|py_compile)\b/i,
  /\b(?:python3?|node)\s+\S*(?:test|spec|check)\S*/i,
  // Running the program the user asked for is the check. Extra args such as
  // `setup.py install` stay may_mutate so a real installer cannot clear the gate.
  /^\s*(?:python3?|node)\s+(?:-[uBI]+\s+)*\.?\/?[\w.-][\w./-]*\.(?:py|js|mjs|cjs)\s*$/i,
];

const READ_ONLY_BASH_PATTERNS = [
  /^\s*(?:pwd|ls\b|find\b|cat\b|head\b|tail\b|sed\s+-n\b|grep\b|rg\b|wc\b|du\b|file\b|stat\b|md5sum\b|sha1sum\b|sha256sum\b|cksum\b|echo\b|printf\b|date\b|id\b|whoami\b|uname\b|true\b|false\b|test\b|\[|dirname\b|basename\b|realpath\b|readlink\b|which\b|type\b|cut\b|sort\b|uniq\b|tr\b|nl\b|od\b|hexdump\b|cmp\b|diff\b|comm\b|awk\b|column\b|cd\b|export\b|unset\b)/i,
  /^\s*git\s+(?:status|diff|log|show|branch|rev-parse|blame)\b/i,
  /^\s*(?:node|python|python3)\s+--version\b/i,
];

const STATIC_ASSET_EXTENSIONS = new Set(['html', 'htm', 'css', 'svg', 'md', 'txt', 'json', 'xml', 'csv']);

const ONE_SHOT_MUTATION = /\b(?:writeFileSync|writeFile|appendFile|createWriteStream|mkdirSync|rmSync|unlinkSync|write_text|write_bytes|os\.(?:remove|unlink|rmdir|replace)|shutil|pathlib|sed\s+-i|\btee\b|open\s*\([^)]*['"](?:[wax]|r\+))/i;

/** Split a command line into the individual commands it will actually run. */
function bashSegments(text) {
  return String(text || '')
    .split(/\|\||&&|[|;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function stripQuotedStrings(text) {
  return String(text || '').replace(/(['"])(?:\\.|(?!\1)[\s\S])*\1/g, ' ');
}

function stripFdRedirects(text) {
  return String(text || '').replace(/\s+\d*>&\d+\b/g, '');
}

function hasUnquotedRedirectOrSubstitution(text) {
  const stripped = stripQuotedStrings(stripFdRedirects(text));
  return />/.test(stripped) || /\$\(|`/.test(stripped);
}

function classifyOneShotSegment(segment) {
  if (!/^\s*(?:python3?|node)\s+-[ce]\s+/i.test(segment)) return null;
  if (ONE_SHOT_MUTATION.test(segment)) return 'may_mutate';
  return 'verification';
}

export function classifyBash(command) {
  const text = String(command || '').trim();
  if (!text) return 'read_only';
  // Only unquoted redirections/substitutions write. `2>&1` and `>` inside
  // `python -c "..."` must not turn a check into a fake workspace mutation.
  if (hasUnquotedRedirectOrSubstitution(text)) return 'may_mutate';
  // A quoted python/node one-liner may contain newlines. Segmenting on `\n`
  // would treat the script body as extra shell commands and never count as a check.
  const oneShotWhole = classifyOneShotSegment(text);
  if (oneShotWhole) return oneShotWhole;
  // Classify every segment. A verification command followed by a mutation
  // (`npm test && sed -i ...`) must not clear the completion gate.
  const segments = bashSegments(text);
  if (!segments.length) return 'read_only';
  let hasVerification = false;
  for (const segment of segments) {
    const oneShot = classifyOneShotSegment(segment);
    if (oneShot === 'may_mutate') return 'may_mutate';
    if (oneShot === 'verification') {
      hasVerification = true;
      continue;
    }
    if (VERIFY_PATTERNS.some((rx) => rx.test(segment))) {
      hasVerification = true;
      continue;
    }
    if (READ_ONLY_BASH_PATTERNS.some((rx) => rx.test(segment))) continue;
    return 'may_mutate';
  }
  return hasVerification ? 'verification' : 'read_only';
}

function isStaticAssetPath(value) {
  const rel = String(value || '').trim().replace(/\\/g, '/');
  if (!rel || rel === '.' || rel.includes('..') || rel.endsWith('/')) return false;
  const base = rel.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return STATIC_ASSET_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

function staticAssetsVerified(state) {
  const paths = [...new Set([...(state.changedPaths || []), ...(state.pendingReadbacks || [])])];
  return paths.length > 0 && paths.every(isStaticAssetPath);
}

export const MAX_COMPLETION_GATE_REMINDERS = 3;

export function shouldEnforceCompletionGate(strategy, reminders = 0) {
  if (!completionGate(strategy)) return false;
  return Number(reminders) < MAX_COMPLETION_GATE_REMINDERS;
}

export function createTurnStrategy(goal = '') {
  return {
    goal: String(goal || '').trim().slice(0, 8_000),
    plan: [],
    changed: false,
    needsVerification: false,
    pendingReadbacks: [],
    verificationUnavailable: false,
    verificationAttempts: 0,
    lastVerificationOk: null,
    toolErrors: 0,
    mutationEpoch: 0,
    verificationEpoch: -1,
    changedPaths: [],
    lastVerificationEvidence: null,
  };
}

function normalizeStrategyEvidence(state) {
  if (!Number.isFinite(Number(state.mutationEpoch))) state.mutationEpoch = 0;
  if (!Number.isFinite(Number(state.verificationEpoch))) state.verificationEpoch = -1;
  if (!Array.isArray(state.changedPaths)) state.changedPaths = [];
  if (!('lastVerificationEvidence' in state)) state.lastVerificationEvidence = null;
  return state;
}

function noteMutation(state, paths = []) {
  normalizeStrategyEvidence(state);
  state.changed = true;
  state.needsVerification = true;
  state.lastVerificationOk = null;
  state.mutationEpoch += 1;
  state.lastVerificationEvidence = null;
  for (const raw of paths) {
    const changedPath = String(raw || '').trim();
    if (!changedPath || state.changedPaths.includes(changedPath)) continue;
    state.changedPaths.push(changedPath);
    if (state.changedPaths.length > 50) state.changedPaths.shift();
  }
}

function noteVerification(state, { ok, tool, detail = '' }) {
  normalizeStrategyEvidence(state);
  state.verificationAttempts += 1;
  state.lastVerificationOk = Boolean(ok);
  state.lastVerificationEvidence = {
    tool: String(tool || ''),
    detail: String(detail || '').slice(0, 500),
    ok: Boolean(ok),
    mutationEpoch: state.mutationEpoch,
    at: Date.now(),
  };
  if (ok) {
    state.needsVerification = false;
    state.verificationEpoch = state.mutationEpoch;
  }
}

export function observeTool(strategy, call, result) {
  const state = normalizeStrategyEvidence(strategy);
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
      const paths = result?.mutatedPaths?.length ? result.mutatedPaths : [call?.arguments?.path].filter(Boolean);
      noteMutation(state, paths);
      if (name === 'write' || name === 'edit') {
        const changedPath = String(call?.arguments?.path || '').trim();
        if (changedPath && !state.pendingReadbacks.includes(changedPath)) state.pendingReadbacks.push(changedPath);
      }
    }
    return state;
  }

  if (name === 'read' && !result?.isError) {
    const readPath = String(call?.arguments?.path || '').trim();
    state.pendingReadbacks = state.pendingReadbacks.filter((changedPath) => changedPath !== readPath);
    if (state.needsVerification && state.pendingReadbacks.length === 0) {
      if (!shellSandboxAvailable()) {
        state.needsVerification = false;
        state.verificationUnavailable = true;
        state.verificationEpoch = state.mutationEpoch;
        state.lastVerificationEvidence = { tool: 'read', detail: 'changed files read back; executable verification unavailable', ok: true, mutationEpoch: state.mutationEpoch, at: Date.now(), executable: false };
      } else if (staticAssetsVerified(state)) {
        noteVerification(state, { ok: true, tool: 'read', detail: 'static assets read back after the latest change' });
      }
    }
    return state;
  }

  if (name === 'bash') {
    const effect = classifyBash(call?.arguments?.command);
    if (effect === 'verification') {
      const exit = Number(result?.metadata?.exit);
      const ok = !result?.isError && (!Number.isFinite(exit) || exit === 0);
      noteVerification(state, { ok, tool: 'bash', detail: String(call?.arguments?.command || '') });
      return state;
    }
    if (effect === 'may_mutate' && !result?.isError) {
      noteMutation(state, result?.mutatedPaths?.length ? result.mutatedPaths : ['.']);
    }
    return state;
  }

  // Dedicated verification tools must satisfy the same completion gate as an
  // equivalent bash command. Otherwise the model can run the purpose-built
  // test/typecheck tools successfully and still be forced into a redundant
  // verification loop.
  if (name === 'run_tests') {
    const exit = Number(result?.metadata?.tests?.exit);
    const ok = !result?.isError && Number.isFinite(exit) && exit === 0;
    noteVerification(state, { ok, tool: 'run_tests', detail: String(call?.arguments?.command || 'auto') });
    return state;
  }

  if (name === 'diagnostics') {
    const ok = !result?.isError && result?.metadata?.diagnostics?.ok === true;
    noteVerification(state, { ok, tool: 'diagnostics', detail: String(call?.arguments?.kind || 'auto') });
    return state;
  }

  // A writer subagent executes behind the parent `task` tool. Its concrete
  // edits are surfaced through mutatedPaths, so the parent turn must inherit
  // the changed/needs-verification state instead of being allowed to finish as
  // if the delegated work were read-only.
  if (name === 'task' && !result?.isError && result?.mutatedPaths?.length) {
    noteMutation(state, result.mutatedPaths);
  }

  if (name === 'browser' && !result?.isError) {
    const action = String(call?.arguments?.action || '').toLowerCase();
    const url = String(call?.arguments?.url || '');
    const local = Boolean(call?.arguments?.html) || (url && !/^https?:\/\//i.test(url));
    if ((action === 'open' || action === 'snapshot') && local && state.needsVerification) {
      noteVerification(state, { ok: true, tool: 'browser', detail: url || 'workspace document' });
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
      `Do not finish yet. Re-read every file you changed${strategy.pendingReadbacks?.length ? `: ${strategy.pendingReadbacks.join(', ')}` : ''}, confirm the edit is complete and internally consistent, and state in the final answer that automated verification was unavailable.`,
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
  if (strategy?.changedPaths?.length) lines.push(`Changed paths (latest tracked set): ${strategy.changedPaths.slice(-12).join(', ')}`);
  if (strategy?.needsVerification && shellSandboxAvailable()) lines.push('Workspace state: changed since the last successful executable verification; verification is required before completion. Prefer a test/check that covers the changed paths above rather than an unrelated green command.');
  else if (strategy?.needsVerification) lines.push('Workspace state: changed, but executable verification is unavailable in this runtime. Inspect the changed files with read/grep and report this verification limitation explicitly.');
  else if (strategy?.changed && strategy?.lastVerificationOk) lines.push(`Workspace state: mutation epoch ${strategy.mutationEpoch ?? 0} has successful verification evidence${strategy.lastVerificationEvidence?.detail ? ` (${strategy.lastVerificationEvidence.tool}: ${strategy.lastVerificationEvidence.detail})` : ''}.`);
  else if (strategy?.changed && strategy?.verificationUnavailable) lines.push('Workspace state: changed files were read back successfully; executable verification was unavailable and must be disclosed in the final answer.');
  return lines.join('\n');
}
