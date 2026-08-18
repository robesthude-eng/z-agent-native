// Tool-call parts: stable signatures, part <-> call conversion, recovery hints and retry backoff.
// Extracted from agent.mjs so the orchestrator keeps only turn lifecycle logic.
import { classifyBash, createTurnStrategy, observeTool } from './context.mjs';
import { partId } from './ids.mjs';
import { mutatesWorkspace } from './tools.mjs';
import { createLoopGuard, observeToolLoop } from './turn-trust.mjs';

const RECOVERY_INSPECTION_TOOLS = new Set(['read', 'list', 'glob', 'grep', 'repo_map', 'environment_status', 'task']);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
  return out;
}

function stableString(value) {
  try { return JSON.stringify(stableValue(value)); } catch { return String(value ?? ''); }
}

export function toolCallSignature(call) {
  return `${String(call?.name || '').trim().toLowerCase()}:${stableString(call?.arguments || {})}`;
}

export function toolMayHaveSideEffects(name) {
  const normalized = String(name || '').trim().toLowerCase();
  return mutatesWorkspace(normalized) || normalized === 'ensure_environment';
}

export function toolCallFromPart(part) {
  return {
    id: String(part?.callID || ''),
    name: String(part?.tool || ''),
    arguments: part?.state?.input && typeof part.state.input === 'object' ? part.state.input : {},
  };
}

function toolResultFromPart(part) {
  const state = part?.state && typeof part.state === 'object' ? part.state : {};
  return {
    content: typeof state.output === 'string' ? state.output : JSON.stringify(state.output ?? ''),
    isError: state.status === 'error',
    metadata: state.metadata && typeof state.metadata === 'object' ? state.metadata : {},
    mutatedPaths: Array.isArray(state.metadata?.mutatedPaths) ? state.metadata.mutatedPaths : [],
  };
}

export function rebuildStrategy(goal, assistant) {
  const strategy = createTurnStrategy(goal);
  for (const part of assistant.parts || []) {
    if (part?.type !== 'tool') continue;
    const state = part.state && typeof part.state === 'object' ? part.state : {};
    if (!['completed', 'error'].includes(String(state.status || ''))) continue;
    const call = toolCallFromPart(part);
    const result = toolResultFromPart(part);
    observeTool(strategy, call, result);
    if (state.metadata?.restartAmbiguous) {
      strategy.changed = true;
      strategy.needsVerification = true;
      strategy.lastVerificationOk = null;
    }
  }
  return strategy;
}

export function rebuildLoopGuard(assistant) {
  const guard = createLoopGuard();
  let stop = null;
  for (const part of assistant.parts || []) {
    if (part?.type !== 'tool') continue;
    const state = part.state && typeof part.state === 'object' ? part.state : {};
    if (!['completed', 'error'].includes(String(state.status || '')) || state.metadata?.restartInterrupted) continue;
    stop = observeToolLoop(guard, toolCallFromPart(part), toolResultFromPart(part)) || stop;
  }
  return { guard, stop };
}

export function isInspectionResult(call, result) {
  if (result?.isError) return false;
  const name = String(call?.name || '').toLowerCase();
  if (RECOVERY_INSPECTION_TOOLS.has(name)) return true;
  return name === 'bash' && classifyBash(call?.arguments?.command) === 'read_only';
}

export function recoveryGuidance(recovery) {
  if (!recovery?.resumed) return '';
  const lines = [
    '[Durable runtime recovery]',
    'This is the same agent turn resumed after a server-process restart.',
    'Completed tool results already present in context are authoritative checkpoints. Do not repeat them merely to reconstruct state.',
  ];
  if (recovery.ambiguousSignatures.size && !recovery.inspected) {
    lines.push('At least one mutating action was in flight when the process stopped. It may have partially completed. Inspect the current workspace/environment before retrying an equivalent mutating action. The runtime will block an identical retry until a successful inspection occurs.');
  }
  return lines.join('\n');
}

export function toolPart(call) {
  return {
    id: partId(),
    type: 'tool',
    tool: call.name,
    callID: call.id,
    state: { status: 'running', input: call.arguments || {}, title: call.name, time: { start: Date.now() } },
  };
}

export function waitForRetry(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('Turn cancelled'), { name: 'AbortError' }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(Object.assign(new Error('Turn cancelled'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
