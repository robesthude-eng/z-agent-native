import { toolCallSignature, toolPart, waitForRetry } from '../agent-parts.mjs';
import { assertChatToolAllowed } from '../chat-tool-options.mjs';
import { emit } from '../events.mjs';
import { isIncompleteToolCall } from '../providers.mjs';
import { putMessage, workspaceFor } from '../store.mjs';
import { runSubagent } from '../subagent-runner.mjs';
import { spillLargeOutput } from '../tool-output-spill.mjs';
import { assertValidToolInput, executeTool, toolOutputText } from '../tools.mjs';
import { createProgressLog } from '../tools/progress.mjs';
import { retryDelayMs, shouldRetryToolCall } from '../turn-trust.mjs';
import { COUNCIL_MAX_PER_TURN, runCouncil } from './council.mjs';
import { observeFileTool, overwriteGate } from './file-awareness.mjs';
import { emitPart } from './message-parts.mjs';
import { askQuestion } from './questions.mjs';

export function strategyInfo(strategy) {
  return {
    changed: strategy.changed,
    changedPaths: Array.isArray(strategy.changedPaths) ? strategy.changedPaths.slice(-50) : [],
    mutationEpoch: Number(strategy.mutationEpoch) || 0,
    verificationEpoch: Number.isFinite(Number(strategy.verificationEpoch)) ? Number(strategy.verificationEpoch) : -1,
    verificationAttempts: strategy.verificationAttempts,
    lastVerificationOk: strategy.lastVerificationOk,
    lastVerificationEvidence: strategy.lastVerificationEvidence || null,
    gitEvidence: strategy.gitEvidence || null,
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

/**
 * Cards of a step are drawn while the model streams (see tool-stream.mjs) and
 * stay `pending` until their turn. Starting a call turns its card into a
 * running one in place, so the user sees one continuous card per call.
 */
function startPart(call, livePart) {
  if (!livePart) return toolPart(call);
  livePart.callID = call.id;
  livePart.state = {
    status: 'running',
    input: call.arguments || {},
    title: livePart.state?.title || call.name,
    time: { start: Date.now() },
  };
  return livePart;
}

export async function executeCall(sessionId, assistant, call, controller, runtime, updateTurn = null, livePart = null) {
  const part = startPart(call, livePart);
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
      output:
        'Blocked by durable-recovery safety: this exact mutating action may already have partially executed before the restart. Inspect current state first, then decide whether a new action is required.',
      metadata: { ...(part.state?.metadata || {}), restartGuardBlocked: true },
      time: { ...part.state.time, end: Date.now() },
    };
    emitPart(assistant, part, { putMessage, emit });
    return { content: part.state.output, isError: true, metadata: part.state.metadata, mutatedPaths: [] };
  }

  try {
    assertChatToolAllowed(call.name, runtime?.toolOptions);
    const workspace = workspaceFor(sessionId);
    const gated = overwriteGate(sessionId, workspace, call);
    if (gated) {
      part.state = {
        ...part.state,
        status: 'completed',
        output: gated,
        title: 'Файл не перезаписан: сначала прочитайте его',
        metadata: { ...(part.state?.metadata || {}), runtimeGate: 'overwrite-unread' },
        time: { ...part.state.time, end: Date.now() },
      };
      emitPart(assistant, part, { putMessage, emit });
      return { content: gated, isError: true, metadata: part.state.metadata, mutatedPaths: [] };
    }
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
    if (String(call.name || '').toLowerCase() === 'council') {
      if (!runtime?.councilOn)
        throw new Error('The model council is switched off. The owner can enable it in Settings → Agent or ask for it explicitly.');
      if ((runtime.councilCalls || 0) >= COUNCIL_MAX_PER_TURN)
        throw new Error(`The council was already convened ${COUNCIL_MAX_PER_TURN} times in this task; decide on your own.`);
      runtime.councilCalls = (runtime.councilCalls || 0) + 1;
      const progress = createProgressLog(emitLiveOutput);
      progress.step('Совет моделей обсуждает развилку…');
      try {
        result = await runCouncil({
          ownerId: runtime.ownerId,
          modelPlan: runtime.modelPlan,
          input: assertValidToolInput('council', call.arguments || {}),
          signal: controller.signal,
        });
      } finally {
        progress.stop();
      }
    } else if (String(call.name || '').toLowerCase() === 'task') {
      // The subagent works for minutes without producing process output; its
      // steps (model calls, tools it runs) are shown as a live timeline.
      const progress = createProgressLog(emitLiveOutput);
      let subagent;
      try {
        subagent = await runSubagent({
          ownerId: runtime.ownerId,
          modelPlan: runtime.modelPlan,
          input: assertValidToolInput('task', call.arguments || {}),
          workspace,
          signal: controller.signal,
          projectContext: runtime.projectContext,
          sessionId,
          progress,
        });
      } finally {
        progress.stop();
      }
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
            requestedModel: runtime.modelPlan?.locked ? runtime.modelPlan.candidates?.[0] || null : null,
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
      const q = await askQuestion(
        sessionId,
        result.questions,
        controller.signal,
        (id) => {
          part.state = {
            ...part.state,
            metadata: { ...(part.state?.metadata || {}), questionId: id },
          };
          emitPart(assistant, part, { putMessage, emit });
        },
        updateTurn,
      );
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
    const resultMetadata = { ...(part.state?.metadata || {}), ...(result?.metadata || {}), mutatedPaths: result?.mutatedPaths || [] };
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
    observeFileTool(sessionId, call, result);
    // Картинки для модели (view_media) идут отдельно от текста и в БД не пишутся.
    const visualMedia = Array.isArray(result?.visualMedia) ? result.visualMedia.filter((m) => m && typeof m.dataUrl === 'string') : [];
    const fullText = toolOutputText(result);
    const spilled = spillLargeOutput({
      workspace: workspaceFor(sessionId),
      sessionId,
      callId: call.id,
      toolName: call.name,
      text: fullText,
    });
    return {
      content: spilled ? spilled.content : fullText,
      isError: false,
      metadata: spilled ? { ...resultMetadata, outputFile: spilled.file } : resultMetadata,
      mutatedPaths: result?.mutatedPaths || [],
      visualMedia,
    };
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
