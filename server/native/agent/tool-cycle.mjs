import { emit } from '../events.mjs';
import { putMessage, workspaceFor } from '../store.mjs';
import { executeTool, toolOutputText } from '../tools.mjs';
import { isIncompleteToolCall } from '../providers.mjs';
import { runSubagent } from '../subagent-runner.mjs';
import { emitPart } from './message-parts.mjs';
import { askQuestion } from './questions.mjs';
import { retryDelayMs, shouldRetryToolCall } from '../turn-trust.mjs';
import { toolCallSignature, toolPart, waitForRetry } from '../agent-parts.mjs';

export function strategyInfo(strategy) {
  return {
    changed: strategy.changed,
    changedPaths: Array.isArray(strategy.changedPaths) ? strategy.changedPaths.slice(-50) : [],
    mutationEpoch: Number(strategy.mutationEpoch) || 0,
    verificationEpoch: Number.isFinite(Number(strategy.verificationEpoch)) ? Number(strategy.verificationEpoch) : -1,
    verificationAttempts: strategy.verificationAttempts,
    lastVerificationOk: strategy.lastVerificationOk,
    lastVerificationEvidence: strategy.lastVerificationEvidence || null,
    toolErrors: strategy.toolErrors,
  };
}

export function assistantHasProgress(assistant, strategy) {
  if (strategy.changed) return true;
  for (const part of assistant?.parts || []) {
    if (part?.type === 'text' && String(part.text || '').trim()) return true;
    if (part?.type === 'tool' && part.state?.status === 'completed' && !part.state?.isError) return true;
  }
  return false;
}

export async function executeCall(sessionId, assistant, call, controller, runtime, updateTurn = null) {
  const part = toolPart(call);
  emitPart(assistant, part, { putMessage, emit });
  if (isIncompleteToolCall(call)) {
    const output = 'Аргументы инструмента обрезаны или не являются JSON. Вызов не выполнен. Повторите его с полными аргументами.';
    part.state = {
      ...part.state,
      status: 'error',
      output,
      metadata: { ...(part.state?.metadata || {}), incompleteArguments: true },
      time: { ...part.state.time, end: Date.now() },
    };
    emitPart(assistant, part, { putMessage, emit });
    return { content: output, isError: true, metadata: part.state.metadata, mutatedPaths: [] };
  }
  const recovery = runtime?.recovery;
  const signature = toolCallSignature(call);
  if (recovery?.resumed && recovery.ambiguousSignatures.has(signature) && !recovery.inspected) {
    part.state = {
      ...part.state,
      status: 'error',
      output: 'Blocked by durable-recovery safety: this exact mutating action may already have partially executed before the restart. Inspect current state first, then decide whether a new action is required.',
      metadata: { ...(part.state?.metadata || {}), restartGuardBlocked: true },
      time: { ...part.state.time, end: Date.now() },
    };
    emitPart(assistant, part, { putMessage, emit });
    return { content: part.state.output, isError: true, metadata: part.state.metadata, mutatedPaths: [] };
  }

  try {
    const workspace = workspaceFor(sessionId);
    const emitLiveOutput = (text) => {
      if (controller.signal.aborted) return;
      const status = String(part.state?.status || '');
      if (status && status !== 'running' && status !== 'pending') return;
      part.state = {
        ...part.state,
        metadata: { ...(part.state?.metadata || {}), output: text },
      };
      emit(assistant.sessionID, 'message.part.updated', { messageID: assistant.id, part });
    };
    let result;
    if (String(call.name || '').toLowerCase() === 'task') {
      const subagent = await runSubagent({
        ownerId: runtime.ownerId,
        modelPlan: runtime.modelPlan,
        input: call.arguments || {},
        workspace,
        signal: controller.signal,
        projectContext: runtime.projectContext,
        sessionId,
      });
      result = {
        output: subagent.report,
        title: call.arguments?.description || `${subagent.kind} subagent report`,
        mutatedPaths: subagent.mutatedPaths || [],
        metadata: {
          subagent: true,
          agent: subagent.kind,
          steps: subagent.steps,
          repositorySnapshot: subagent.repositorySnapshot,
          model: subagent.model,
        },
      };
    } else {
      let attempt = 0;
      while (true) {
        try {
          result = await executeTool(call.name, call.arguments || {}, {
            workspace,
            sessionId,
            ownerId: runtime.ownerId,
            signal: controller.signal,
            onOutput: emitLiveOutput,
          });
          break;
        } catch (err) {
          if (err?.name === 'AbortError' || controller.signal.aborted) throw err;
          if (!shouldRetryToolCall(call, err, attempt)) throw err;
          attempt += 1;
          part.state = {
            ...part.state,
            status: 'running',
            metadata: {
              ...(part.state?.metadata || {}),
              retryCount: attempt,
              lastRetryError: err?.message || String(err),
            },
          };
          emitPart(assistant, part, { putMessage, emit });
          await waitForRetry(retryDelayMs(attempt - 1), controller.signal);
        }
      }
    }
    if (result?.kind === 'question') {
      const q = await askQuestion(sessionId, result.questions, controller.signal, (id) => {
        part.state = {
          ...part.state,
          metadata: { ...(part.state?.metadata || {}), questionId: id },
        };
        emitPart(assistant, part, { putMessage, emit });
      }, updateTurn);
      part.state = {
        ...part.state,
        status: 'completed',
        output: `User answered: ${JSON.stringify(q.answers)}`,
        metadata: { ...(part.state?.metadata || {}), answers: q.answers, questionId: q.id },
        time: { ...part.state.time, end: Date.now() },
      };
      emitPart(assistant, part, { putMessage, emit });
      return { content: JSON.stringify({ answers: q.answers }), isError: false, metadata: part.state.metadata, mutatedPaths: [] };
    }
    const resultMetadata = { ...(part.state?.metadata || {}), ...(result?.metadata || {}) };
    part.state = {
      ...part.state,
      status: 'completed',
      output: toolOutputText(result),
      title: result?.title || part.state.title,
      metadata: resultMetadata,
      time: { ...part.state.time, end: Date.now() },
    };
    emitPart(assistant, part, { putMessage, emit });
    if (result?.mutatedPaths?.length) emit(sessionId, 'file.edited', { paths: result.mutatedPaths });
    return { content: toolOutputText(result), isError: false, metadata: resultMetadata, mutatedPaths: result?.mutatedPaths || [] };
  } catch (err) {
    part.state = {
      ...part.state,
      status: 'error',
      output: `Error: ${err?.message || String(err)}`,
      time: { ...part.state.time, end: Date.now() },
    };
    emitPart(assistant, part, { putMessage, emit });
    if (err?.name === 'AbortError' || controller.signal.aborted) throw err;
    return { content: `Error: ${err?.message || String(err)}`, isError: true, metadata: part.state?.metadata || {}, mutatedPaths: [] };
  }
}
