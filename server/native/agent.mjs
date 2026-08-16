import fs from 'node:fs';
import path from 'node:path';
import {
  clearTurn, claimAction, completeAction, createQuestion, failAction, getAction, getChat, getQuestion,
  listMessages, putMessage, renameChat, resolveQuestion,
  setTurn, workspaceFor,
} from './store.mjs';
import { emit } from './events.mjs';
import { messageId, partId, questionId, turnId } from './ids.mjs';
import {
  buildModelPlan,
  callModelAutopilot,
  modelKey,
  promoteModelPlan,
  subagentStepBudget,
  taskStepBudget,
} from './autopilot.mjs';
import { clearProjectContext, getProjectContext, rememberProjectTurn } from './project-context.mjs';
import { safeWorkspacePath } from './security.mjs';
import { availableToolDefinitions, executeTool, mutatesWorkspace, TOOL_DEFINITIONS, toolOutputText } from './tools.mjs';
import { compactFrames, completionGate, createTurnStrategy, observeTool, strategyGuidance } from './context.mjs';
import { getSubagentProfile } from './subagents.mjs';
import {
  classifyTaskOutcome,
  createLoopGuard,
  guardStopError,
  observeToolLoop,
  retryDelayMs,
  shouldRetryToolCall,
  stepLimitError,
} from './turn-trust.mjs';

const SYSTEM_FILE = new URL('../system-instruction.txt', import.meta.url);
let cachedSystem = null;
const activeTurns = new Map();
const activeActions = new Map();
const questionWaiters = new Map();

function systemPrompt() {
  if (cachedSystem == null) cachedSystem = fs.readFileSync(SYSTEM_FILE, 'utf8');
  return cachedSystem;
}

function textParts(message) {
  return (message.parts || [])
    .filter((part) => (part?.type === 'text' || part?.type === 'reasoning') && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n\n')
    .trim();
}

function attachmentRefs(message) {
  return (message.parts || [])
    .filter((part) => part?.type === 'attachment' && typeof part.path === 'string' && part.path)
    .map((part) => ({
      name: String(part.name || path.basename(part.path) || 'attachment'),
      path: String(part.path),
      kind: String(part.kind || 'binary'),
      mime: String(part.mime || 'application/octet-stream'),
      size: Number(part.size) || 0,
      note: typeof part.note === 'string' ? part.note : '',
    }));
}

function attachmentContext(message) {
  const refs = attachmentRefs(message);
  if (!refs.length) return '';
  const lines = refs.map((ref) => `- ${ref.name} -> ${ref.path}${ref.note ? ` (${ref.note})` : ''}`);
  return ['[User attachments already present in this chat workspace]', ...lines, 'Use workspace tools with these relative paths.'].join('\n');
}

function messageMedia(message, workspace) {
  const out = [];
  for (const part of message.parts || []) {
    if (part?.type !== 'attachment') continue;
    if (!['image', 'pdf'].includes(String(part.kind || ''))) continue;
    try {
      const full = safeWorkspacePath(workspace, String(part.path || ''), { allowMissing: false });
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > 20 * 1024 * 1024) continue;
      const mime = String(part.mime || (part.kind === 'pdf' ? 'application/pdf' : 'application/octet-stream'));
      const dataUrl = `data:${mime};base64,${fs.readFileSync(full).toString('base64')}`;
      out.push({ name: String(part.name || path.basename(full)), kind: String(part.kind), dataUrl });
    } catch { /* attachment may have been removed after the message was sent */ }
  }
  return out;
}

function framesFromMessages(messages, workspace) {
  const frames = [];
  for (const msg of messages) {
    if (msg.role === 'user') {
      const visible = textParts(msg);
      const internal = attachmentContext(msg);
      const content = [visible, internal].filter(Boolean).join('\n\n');
      const media = messageMedia(msg, workspace);
      if (content || media.length) frames.push({ role: 'user', content, media });
      continue;
    }
    if (msg.role !== 'assistant') continue;
    const content = textParts(msg);
    const tools = (msg.parts || []).filter((part) => part?.type === 'tool' && part.callID && part.tool);
    const toolCalls = tools.map((part) => ({
      id: String(part.callID),
      name: String(part.tool),
      arguments: part.state?.input && typeof part.state.input === 'object' ? part.state.input : {},
    }));
    if (content || toolCalls.length) frames.push({ role: 'assistant', content, toolCalls });
    for (const part of tools) {
      const state = part.state && typeof part.state === 'object' ? part.state : {};
      if (!['completed', 'error'].includes(state.status)) continue;
      frames.push({
        role: 'tool',
        callId: String(part.callID),
        name: String(part.tool),
        content: typeof state.output === 'string' ? state.output : JSON.stringify(state.output ?? ''),
        isError: state.status === 'error',
      });
    }
  }
  return frames;
}

function userPartsFromPrompt(parts, workspace) {
  const ui = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (part?.type === 'text' && typeof part.text === 'string') {
      ui.push({ type: 'text', text: part.text });
      continue;
    }
    if (part?.type !== 'attachment' || typeof part.path !== 'string') continue;
    try {
      const full = safeWorkspacePath(workspace, part.path, { allowMissing: false });
      if (!fs.statSync(full).isFile()) continue;
      ui.push({
        type: 'attachment',
        name: String(part.name || path.basename(full)),
        path: path.relative(workspace, full).split(path.sep).join('/'),
        size: Number(part.size) || fs.statSync(full).size,
        kind: String(part.kind || 'binary'),
        mime: String(part.mime || 'application/octet-stream'),
        ...(typeof part.note === 'string' && part.note ? { note: part.note.slice(0, 300) } : {}),
      });
    } catch { /* forged/stale path is not accepted into the chat record */ }
  }
  return ui;
}

function promptText(parts) {
  return (Array.isArray(parts) ? parts : []).filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n\n').trim();
}

function updateTurn(sessionId, state) {
  const now = Date.now();
  const current = activeTurns.get(sessionId);
  const projection = {
    turnId: current?.turnId || state.turnId || turnId(),
    lifecycle: state.lifecycle,
    verdict: state.verdict ?? null,
    reason: state.reason ?? null,
    since: state.since ?? now,
  };
  setTurn(sessionId, projection);
  emit(sessionId, 'session.status', { status: projection.lifecycle === 'waiting_user_input' ? 'busy' : projection.lifecycle === 'failed' ? 'error' : projection.lifecycle === 'completed' || projection.lifecycle === 'cancelled' ? 'idle' : 'busy' });
  return projection;
}

function persistAssistant(assistant) {
  putMessage(assistant);
  emit(assistant.sessionID, 'message.updated', { message: assistant });
}

function emitPart(assistant, part) {
  const i = assistant.parts.findIndex((p) => p.id === part.id);
  if (i === -1) assistant.parts.push(part); else assistant.parts[i] = part;
  putMessage(assistant);
  emit(assistant.sessionID, 'message.part.updated', { messageID: assistant.id, part });
}

async function emitText(assistant, text, type = 'text') {
  if (!text) return;
  const part = { id: partId(), type, text: '' };
  assistant.parts.push(part);
  emit(assistant.sessionID, 'message.part.updated', { messageID: assistant.id, part });
  const chunks = String(text).match(/[\s\S]{1,96}/g) || [];
  for (const chunk of chunks) {
    part.text += chunk;
    emit(assistant.sessionID, 'message.part.delta', { messageID: assistant.id, partID: part.id, field: 'text', delta: chunk });
  }
  putMessage(assistant);
}

function liveTextSink(assistant) {
  let part = null;
  return {
    push(delta) {
      if (!delta) return;
      if (!part) {
        part = { id: partId(), type: 'text', text: '' };
        assistant.parts.push(part);
        emit(assistant.sessionID, 'message.part.updated', { messageID: assistant.id, part });
      }
      part.text += String(delta);
      emit(assistant.sessionID, 'message.part.delta', { messageID: assistant.id, partID: part.id, field: 'text', delta: String(delta) });
    },
    finish() {
      if (part) putMessage(assistant);
      return Boolean(part?.text);
    },
  };
}

function waitWithAbort(map, id, sessionId, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      map.delete(id);
      cleanup();
      reject(Object.assign(new Error('Turn cancelled'), { name: 'AbortError' }));
    };
    map.set(id, { sessionId, resolve: (value) => { map.delete(id); cleanup(); resolve(value); }, reject: (err) => { map.delete(id); cleanup(); reject(err); } });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function askQuestion(sessionId, questions, signal) {
  const id = questionId();
  createQuestion(id, sessionId, questions);
  updateTurn(sessionId, { lifecycle: 'waiting_user_input', since: Date.now(), reason: 'question' });
  emit(sessionId, 'question.asked', { id, questions });
  const answers = await waitWithAbort(questionWaiters, id, sessionId, signal);
  updateTurn(sessionId, { lifecycle: 'running', since: Date.now(), reason: 'question_answered' });
  return { id, answers };
}

const SUBAGENT_SAFE_TOOLS = TOOL_DEFINITIONS.filter((tool) => ['repo_map', 'read', 'list', 'glob', 'grep'].includes(tool.name));

async function runSubagent(ownerId, modelPlan, input, workspace, signal, projectContext = '') {
  const prompt = String(input?.prompt || '').trim();
  if (!prompt) throw new Error('Subagent prompt must not be empty');
  const profile = getSubagentProfile(input?.agent);
  let repositorySnapshot = '';
  if (!projectContext) {
    try {
      const map = await executeTool('repo_map', { maxFiles: 1800, maxSymbolsPerFile: 4 }, { workspace, signal });
      repositorySnapshot = toolOutputText(map).slice(0, 60_000);
    } catch { /* repository map is an accelerator, not a hard dependency */ }
  }
  const frames = [{
    role: 'user',
    content: [prompt, repositorySnapshot && `[Automatic repository snapshot]\n${repositorySnapshot}`].filter(Boolean).join('\n\n'),
  }];
  const maxSteps = subagentStepBudget(profile, prompt);
  let plan = modelPlan;
  let selectedModel = plan?.candidates?.[0] || null;
  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) throw Object.assign(new Error('Turn cancelled'), { name: 'AbortError' });
    const response = await callModelAutopilot(ownerId, plan, {
      system: [profile.system, projectContext].filter(Boolean).join('\n\n'),
      frames: compactFrames(frames, { maxChars: 180_000, maxObservationChars: 24_000 }),
      tools: SUBAGENT_SAFE_TOOLS,
      signal,
    });
    selectedModel = response.model || selectedModel;
    plan = promoteModelPlan(plan, selectedModel);
    const calls = response.toolCalls || [];
    if (calls.length === 0) {
      return {
        report: response.text || `${profile.name} subagent completed without a written report.`,
        kind: profile.name,
        steps: step + 1,
        repositorySnapshot: Boolean(repositorySnapshot || projectContext),
        model: selectedModel ? modelKey(selectedModel) : '',
      };
    }
    frames.push({ role: 'assistant', content: response.text || '', toolCalls: calls });
    for (const call of calls) {
      if (!SUBAGENT_SAFE_TOOLS.some((tool) => tool.name === call.name)) {
        frames.push({ role: 'tool', callId: call.id, name: call.name, content: `Tool ${call.name} is not allowed in a read-only subagent.`, isError: true });
        continue;
      }
      try {
        const result = await executeTool(call.name, call.arguments || {}, { workspace, signal });
        frames.push({ role: 'tool', callId: call.id, name: call.name, content: toolOutputText(result), isError: false });
      } catch (err) {
        frames.push({ role: 'tool', callId: call.id, name: call.name, content: `Error: ${err?.message || String(err)}`, isError: true });
      }
    }
  }
  return {
    report: `${profile.name} subagent reached its ${maxSteps}-step investigation limit.`,
    kind: profile.name,
    steps: maxSteps,
    repositorySnapshot: Boolean(repositorySnapshot || projectContext),
    model: selectedModel ? modelKey(selectedModel) : '',
  };
}

function toolPart(call) {
  return {
    id: partId(),
    type: 'tool',
    tool: call.name,
    callID: call.id,
    state: { status: 'running', input: call.arguments || {}, title: call.name, time: { start: Date.now() } },
  };
}

function waitForRetry(delayMs, signal) {
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

async function executeCall(sessionId, assistant, call, controller, runtime) {
  const part = toolPart(call);
  emitPart(assistant, part);
  try {
    const workspace = workspaceFor(sessionId);
    let result;
    if (String(call.name || '').toLowerCase() === 'task') {
      const subagent = await runSubagent(runtime.ownerId, runtime.modelPlan, call.arguments || {}, workspace, controller.signal, runtime.projectContext);
      result = {
        output: subagent.report,
        title: call.arguments?.description || `${subagent.kind} subagent report`,
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
          result = await executeTool(call.name, call.arguments || {}, { workspace, sessionId, signal: controller.signal });
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
          emitPart(assistant, part);
          await waitForRetry(retryDelayMs(attempt - 1), controller.signal);
        }
      }
    }
    if (result?.kind === 'question') {
      const q = await askQuestion(sessionId, result.questions, controller.signal);
      part.state = {
        ...part.state,
        status: 'completed',
        output: `User answered: ${JSON.stringify(q.answers)}`,
        metadata: { ...(part.state?.metadata || {}), answers: q.answers, questionId: q.id },
        time: { ...part.state.time, end: Date.now() },
      };
      emitPart(assistant, part);
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
    emitPart(assistant, part);
    if (mutatesWorkspace(call.name) || result?.mutatedPaths?.length) emit(sessionId, 'file.edited', { paths: result?.mutatedPaths || ['.'] });
    return { content: toolOutputText(result), isError: false, metadata: resultMetadata, mutatedPaths: result?.mutatedPaths || [] };
  } catch (err) {
    part.state = {
      ...part.state,
      status: 'error',
      output: `Error: ${err?.message || String(err)}`,
      time: { ...part.state.time, end: Date.now() },
    };
    emitPart(assistant, part);
    if (err?.name === 'AbortError' || controller.signal.aborted) throw err;
    return { content: `Error: ${err?.message || String(err)}`, isError: true, metadata: part.state?.metadata || {}, mutatedPaths: [] };
  }
}

function strategyInfo(strategy) {
  return {
    changed: strategy.changed,
    verificationAttempts: strategy.verificationAttempts,
    lastVerificationOk: strategy.lastVerificationOk,
    toolErrors: strategy.toolErrors,
  };
}

function assistantHasProgress(assistant, strategy) {
  if (strategy?.changed) return true;
  if (Array.isArray(strategy?.plan) && strategy.plan.some((item) => item?.status === 'completed')) return true;
  return (assistant.parts || []).some((part) => {
    if ((part.type === 'text' || part.type === 'reasoning') && String(part.text || '').trim()) return true;
    if (part.type !== 'tool') return false;
    const state = part.state && typeof part.state === 'object' ? part.state : {};
    return state.status === 'completed' || state.status === 'success';
  });
}

async function finalizeAssistant({ sessionId, assistant, strategy, usage, outcome, finish = 'stop', note = '', error = null, lifecycle = 'completed', verdict = 'completed', reason = 'model_final' }) {
  if (note) await emitText(assistant, note, 'text');
  assistant.time.completed = Date.now();
  assistant.info.finish = finish;
  assistant.info.tokens = usage ? {
    input: usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? usage.promptTokenCount,
    output: usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? usage.candidatesTokenCount,
  } : undefined;
  assistant.info.strategy = strategyInfo(strategy);
  assistant.info.outcome = outcome;
  assistant.info.time = { ...(assistant.info.time || {}), completed: assistant.time.completed };
  if (error) assistant.info.error = { message: error?.message || String(error), name: error?.name || 'Error' };
  rememberProjectTurn(sessionId, {
    goal: strategy?.goal || '',
    outcome: outcome?.status || verdict,
    model: assistant.info.model || '',
    changed: Boolean(strategy?.changed),
    summary: textParts(assistant).slice(-2_000),
  });
  persistAssistant(assistant);
  updateTurn(sessionId, { lifecycle, verdict, since: Date.now(), reason });
  emit(sessionId, 'session.idle', {});
  return assistant;
}

export function submitTurn(args) {
  const actionId = String(args.actionId || '').trim();
  if (!actionId) return runTurn(args);
  const key = `${args.sessionId}:${actionId}`;
  const active = activeActions.get(key);
  if (active) return active;
  const prior = getAction(args.sessionId, actionId);
  if (prior?.state === 'completed' && prior.result) return Promise.resolve(prior.result);
  if (prior?.state === 'failed') return Promise.reject(new Error(prior.result?.error || 'Previous attempt failed'));
  if (prior?.state === 'running') return Promise.reject(Object.assign(new Error('This action is already running'), { statusCode: 409 }));
  claimAction(args.sessionId, actionId);
  const promise = runTurn(args)
    .then((result) => { completeAction(args.sessionId, actionId, result); return result; })
    .catch((err) => { failAction(args.sessionId, actionId, err); throw err; })
    .finally(() => activeActions.delete(key));
  activeActions.set(key, promise);
  return promise;
}

function safeAttemptInfo(attempt) {
  return {
    model: modelKey(attempt?.model),
    ok: Boolean(attempt?.ok),
    latencyMs: Math.max(0, Math.round(Number(attempt?.latencyMs) || 0)),
  };
}

export async function runTurn({ sessionId, ownerId, parts, model, system }) {
  if (activeTurns.has(sessionId)) throw Object.assign(new Error('Агент уже выполняет задачу в этом чате'), { statusCode: 409 });
  const controller = new AbortController();
  const tId = turnId();
  activeTurns.set(sessionId, { controller, turnId: tId, ownerId });
  updateTurn(sessionId, { turnId: tId, lifecycle: 'running', since: Date.now(), reason: 'user_message' });

  const workspace = workspaceFor(sessionId);
  const userMessage = {
    id: messageId(), role: 'user', sessionID: sessionId,
    parts: userPartsFromPrompt(parts, workspace),
    time: { created: Date.now(), completed: Date.now() },
    info: { role: 'user', finish: 'stop', time: { created: Date.now(), completed: Date.now() } },
  };
  putMessage(userMessage);
  emit(sessionId, 'message.updated', { message: userMessage });

  const chat = getChat(sessionId, ownerId);
  if (chat?.title === 'Новый чат') {
    const first = promptText(parts).split('\n')[0].trim().slice(0, 72);
    if (first) {
      const updated = renameChat(sessionId, ownerId, first);
      if (updated) emit(sessionId, 'session.updated', { session: updated });
    }
  }

  const assistant = {
    id: messageId(), role: 'assistant', sessionID: sessionId, parts: [],
    time: { created: Date.now() },
    info: { role: 'assistant', time: { created: Date.now() } },
  };
  persistAssistant(assistant);

  const strategy = createTurnStrategy(promptText(parts));
  let lastUsage = null;

  try {
    const runtime = {
      ownerId,
      modelPlan: await buildModelPlan(ownerId, model, strategy.goal),
      projectContext: await getProjectContext(sessionId, workspace, controller.signal),
    };
    const initialModel = runtime.modelPlan.candidates[0];
    assistant.info.model = modelKey(initialModel);
    assistant.info.autopilot = {
      enabled: true,
      budget: taskStepBudget(strategy.goal),
      candidates: runtime.modelPlan.candidates.map(modelKey),
      selected: modelKey(initialModel),
      fallbackCount: 0,
    };
    const history = listMessages(sessionId).filter((m) => m.id !== assistant.id);
    const frames = framesFromMessages(history, workspace);
    const maxSteps = taskStepBudget(strategy.goal);
    const loopGuard = createLoopGuard();
    let gateReminders = 0;
    let guardedStop = null;

    for (let step = 0; step < maxSteps; step++) {
      if (controller.signal.aborted) throw Object.assign(new Error('Turn cancelled'), { name: 'AbortError' });
      const live = liveTextSink(assistant);
      const response = await callModelAutopilot(ownerId, runtime.modelPlan, {
        system: [systemPrompt(), runtime.projectContext, strategyGuidance(strategy), system || ''].filter(Boolean).join('\n\n'),
        frames: compactFrames(frames),
        tools: availableToolDefinitions(),
        signal: controller.signal,
        onTextDelta: (delta) => live.push(delta),
      });
      const streamedText = live.finish();
      runtime.modelPlan = promoteModelPlan(runtime.modelPlan, response.model);
      assistant.info.model = modelKey(response.model);
      const failedAttempts = (response.attempts || []).filter((attempt) => !attempt.ok).length;
      assistant.info.autopilot = {
        ...assistant.info.autopilot,
        candidates: runtime.modelPlan.candidates.map(modelKey),
        selected: modelKey(response.model),
        fallbackCount: Number(assistant.info.autopilot?.fallbackCount || 0) + failedAttempts,
        lastAttempts: (response.attempts || []).map(safeAttemptInfo),
      };
      lastUsage = response.usage || lastUsage;
      const calls = response.toolCalls || [];
      if (calls.length === 0) {
        const gate = completionGate(strategy);
        if (gate) {
          gateReminders += 1;
          frames.push({ role: 'assistant', content: response.text || '', toolCalls: [] });
          frames.push({ role: 'user', content: `${gate}\nReminder attempt: ${gateReminders}.` });
          continue;
        }
        if (!streamedText) await emitText(assistant, response.text || 'Готово.', 'text');
        const outcome = classifyTaskOutcome({ strategy, kind: 'completed' });
        return await finalizeAssistant({
          sessionId,
          assistant,
          strategy,
          usage: lastUsage,
          outcome,
          finish: response.finish || 'stop',
          lifecycle: 'completed',
          verdict: 'completed',
          reason: outcome.reason || 'model_final',
        });
      }

      if (response.text && !streamedText) await emitText(assistant, response.text, 'text');
      frames.push({ role: 'assistant', content: response.text || '', toolCalls: calls });
      for (const call of calls) {
        const result = await executeCall(sessionId, assistant, call, controller, runtime);
        observeTool(strategy, call, result);
        frames.push({ role: 'tool', callId: call.id, name: call.name, content: result.content, isError: result.isError });
        const loop = observeToolLoop(loopGuard, call, result);
        if (loop) {
          guardedStop = guardStopError(loop);
          break;
        }
      }
      if (guardedStop) break;
    }

    const stopError = guardedStop || stepLimitError(maxSteps);
    const progress = assistantHasProgress(assistant, strategy);
    const outcome = classifyTaskOutcome({ strategy, kind: 'failed', reason: stopError.code, progress });
    const failed = outcome.status === 'failed';
    const note = guardedStop
      ? `${guardedStop.message} ${failed ? 'Безопасная защита остановила задачу.' : 'Выполненная часть сохранена; задача остановлена, чтобы не продолжать цикл.'}`
      : `Достигнут безопасный лимит ${maxSteps} шагов автономной работы. ${failed ? 'Задачу не удалось довести до результата.' : 'Выполненная часть сохранена, но задача может быть завершена не полностью.'}`;
    return await finalizeAssistant({
      sessionId,
      assistant,
      strategy,
      usage: lastUsage,
      outcome,
      finish: failed ? 'error' : 'stop',
      note,
      error: failed ? stopError : null,
      lifecycle: failed ? 'failed' : 'completed',
      verdict: failed ? 'failed' : 'completed',
      reason: stopError.code,
    });
  } catch (err) {
    const cancelled = controller.signal.aborted || err?.name === 'AbortError';
    if (cancelled) {
      const outcome = classifyTaskOutcome({ strategy, kind: 'cancelled', reason: 'user_cancelled' });
      return await finalizeAssistant({
        sessionId,
        assistant,
        strategy,
        usage: lastUsage,
        outcome,
        finish: 'stop',
        lifecycle: 'cancelled',
        verdict: 'cancelled',
        reason: err?.message || 'Turn cancelled',
      });
    }

    const progress = assistantHasProgress(assistant, strategy);
    const outcome = classifyTaskOutcome({ strategy, kind: 'failed', reason: err?.code || err?.name || 'runtime_error', progress });
    if (outcome.status === 'partial') {
      return await finalizeAssistant({
        sessionId,
        assistant,
        strategy,
        usage: lastUsage,
        outcome,
        finish: 'error',
        note: `Работа остановилась из-за ошибки: ${err?.message || String(err)}. Выполненная часть сохранена.`,
        lifecycle: 'completed',
        verdict: 'completed',
        reason: outcome.reason,
      });
    }

    if (!(assistant.parts || []).some((p) => p.type === 'text')) await emitText(assistant, `Ошибка агента: ${err?.message || String(err)}`, 'text');
    await finalizeAssistant({
      sessionId,
      assistant,
      strategy,
      usage: lastUsage,
      outcome,
      finish: 'error',
      error: err,
      lifecycle: 'failed',
      verdict: 'failed',
      reason: err?.message || String(err),
    });
    throw err;
  } finally {
    activeTurns.delete(sessionId);
    setTimeout(() => {
      if (!activeTurns.has(sessionId)) clearTurn(sessionId);
    }, 1500).unref?.();
  }
}

export function abortTurn(sessionId) {
  const active = activeTurns.get(sessionId);
  if (!active) return false;
  active.controller.abort();
  for (const [id, waiter] of questionWaiters) if (waiter.sessionId === sessionId) waiter.reject(Object.assign(new Error('Turn cancelled'), { name: 'AbortError' }));
  return true;
}

export function answerQuestion(sessionId, id, answers) {
  const q = getQuestion(id);
  if (!q || q.sessionID !== sessionId || q.status !== 'pending') return false;
  resolveQuestion(id, answers, 'answered');
  emit(sessionId, 'question.replied', { id, answers });
  const waiter = questionWaiters.get(id);
  waiter?.resolve(answers);
  return true;
}

export function rejectQuestion(sessionId, id) {
  const q = getQuestion(id);
  if (!q || q.sessionID !== sessionId || q.status !== 'pending') return false;
  resolveQuestion(id, [], 'rejected');
  emit(sessionId, 'question.rejected', { id });
  const waiter = questionWaiters.get(id);
  waiter?.resolve([]);
  return true;
}

export function isTurnActive(sessionId) { return activeTurns.has(sessionId); }

export async function waitForTurnIdle(sessionId, timeoutMs = 5000) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (activeTurns.has(sessionId) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !activeTurns.has(sessionId);
}

export function clearAgentSessionState(sessionId) {
  if (activeTurns.has(sessionId)) return false;
  for (const key of activeActions.keys()) if (key.startsWith(`${sessionId}:`)) activeActions.delete(key);
  for (const [id, waiter] of questionWaiters) if (waiter.sessionId === sessionId) questionWaiters.delete(id);
  clearProjectContext(sessionId);
  return true;
}

export function resetAgentStateForTests() {
  for (const active of activeTurns.values()) active.controller.abort();
  activeTurns.clear(); activeActions.clear(); questionWaiters.clear();
}
