import fs from 'node:fs';
import path from 'node:path';
import {
  clearTurn, claimAction, completeAction, createPermission, createQuestion, failAction, getAction, getChat, getPermission, getQuestion,
  listMessages, putMessage, renameChat, resolvePermission, resolveQuestion,
  setTurn, workspaceFor,
} from './store.mjs';
import { emit } from './events.mjs';
import { messageId, partId, permissionId, questionId, turnId } from './ids.mjs';
import { buildCatalog, callModel } from './providers.mjs';
import { safeWorkspacePath } from './security.mjs';
import { availableToolDefinitions, executeTool, mutatesWorkspace, requiresPermission, TOOL_DEFINITIONS, toolOutputText } from './tools.mjs';
import { compactFrames, completionGate, createTurnStrategy, observeTool, strategyGuidance } from './context.mjs';
import { getSubagentProfile } from './subagents.mjs';

const SYSTEM_FILE = new URL('../system-instruction.txt', import.meta.url);
let cachedSystem = null;
const activeTurns = new Map();
const activeActions = new Map();
const questionWaiters = new Map();
const permissionWaiters = new Map();
const alwaysAllowed = new Map();

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

async function pickModel(ownerId, requested) {
  if (requested?.providerID && requested?.modelID) return requested;
  const env = process.env.Z_AGENT_DEFAULT_MODEL || '';
  if (env.includes('/')) {
    const i = env.indexOf('/');
    return { providerID: env.slice(0, i), modelID: env.slice(i + 1) };
  }
  const catalog = await buildCatalog(ownerId);
  if (catalog.models[0]) return { providerID: catalog.models[0].providerID, modelID: catalog.models[0].modelID };
  throw Object.assign(new Error('Нет доступной модели. Добавьте API key в Настройки → Провайдеры.'), { statusCode: 400 });
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
  emit(sessionId, 'session.status', { status: ['waiting_permission','waiting_user_input'].includes(projection.lifecycle) ? 'busy' : projection.lifecycle === 'failed' ? 'error' : projection.lifecycle === 'completed' || projection.lifecycle === 'cancelled' ? 'idle' : 'busy' });
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

async function requestPermission(sessionId, tool, input, signal) {
  const allow = alwaysAllowed.get(sessionId);
  if (allow?.has(tool)) return 'always';
  const id = permissionId();
  createPermission(id, sessionId, tool, input);
  updateTurn(sessionId, { lifecycle: 'waiting_permission', since: Date.now(), reason: tool });
  emit(sessionId, 'permission.asked', { id, tool, input });
  const response = await waitWithAbort(permissionWaiters, id, sessionId, signal);
  if (response === 'always') {
    const set = alwaysAllowed.get(sessionId) || new Set();
    set.add(tool);
    alwaysAllowed.set(sessionId, set);
  }
  updateTurn(sessionId, { lifecycle: 'running', since: Date.now(), reason: 'permission_resolved' });
  if (response === 'reject') throw new Error(`Пользователь отклонил выполнение инструмента ${tool}`);
  return response;
}

const SUBAGENT_SAFE_TOOLS = TOOL_DEFINITIONS.filter((tool) => ['repo_map', 'read', 'list', 'glob', 'grep'].includes(tool.name));

async function runSubagent(ownerId, model, input, workspace, signal) {
  const prompt = String(input?.prompt || '').trim();
  if (!prompt) throw new Error('Subagent prompt must not be empty');
  const profile = getSubagentProfile(input?.agent);
  let repositorySnapshot = '';
  try {
    const map = await executeTool('repo_map', { maxFiles: 1800, maxSymbolsPerFile: 4 }, { workspace, signal });
    repositorySnapshot = toolOutputText(map).slice(0, 60_000);
  } catch { /* repository map is an accelerator, not a hard dependency */ }
  const frames = [{
    role: 'user',
    content: [prompt, repositorySnapshot && `[Automatic repository snapshot]\n${repositorySnapshot}`].filter(Boolean).join('\n\n'),
  }];
  const configuredSteps = Number(process.env.Z_AGENT_SUBAGENT_STEPS) || profile.maxSteps;
  const maxSteps = Math.min(20, Math.max(2, configuredSteps));
  for (let step = 0; step < maxSteps; step++) {
    if (signal?.aborted) throw Object.assign(new Error('Turn cancelled'), { name: 'AbortError' });
    const response = await callModel(ownerId, model, {
      system: profile.system,
      frames: compactFrames(frames, { maxChars: 160_000, maxObservationChars: 20_000 }),
      tools: SUBAGENT_SAFE_TOOLS,
      signal,
    });
    const calls = response.toolCalls || [];
    if (calls.length === 0) {
      return {
        report: response.text || `${profile.name} subagent completed without a written report.`,
        kind: profile.name,
        steps: step + 1,
        repositorySnapshot: Boolean(repositorySnapshot),
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
    repositorySnapshot: Boolean(repositorySnapshot),
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

async function executeCall(sessionId, assistant, call, controller, runtime) {
  const part = toolPart(call);
  emitPart(assistant, part);
  try {
    if (requiresPermission(call.name)) await requestPermission(sessionId, call.name, call.arguments, controller.signal);
    const workspace = workspaceFor(sessionId);
    let result;
    if (String(call.name || '').toLowerCase() === 'task') {
      const subagent = await runSubagent(runtime.ownerId, runtime.model, call.arguments || {}, workspace, controller.signal);
      result = {
        output: subagent.report,
        title: call.arguments?.description || `${subagent.kind} subagent report`,
        metadata: { subagent: true, agent: subagent.kind, steps: subagent.steps, repositorySnapshot: subagent.repositorySnapshot },
      };
    } else {
      result = await executeTool(call.name, call.arguments || {}, { workspace, sessionId, signal: controller.signal });
    }
    if (result?.kind === 'question') {
      const q = await askQuestion(sessionId, result.questions, controller.signal);
      part.state = {
        ...part.state,
        status: 'completed',
        output: `User answered: ${JSON.stringify(q.answers)}`,
        metadata: { answers: q.answers, questionId: q.id },
        time: { ...part.state.time, end: Date.now() },
      };
      emitPart(assistant, part);
      return { content: JSON.stringify({ answers: q.answers }), isError: false, metadata: part.state.metadata, mutatedPaths: [] };
    }
    part.state = {
      ...part.state,
      status: 'completed',
      output: toolOutputText(result),
      title: result?.title || part.state.title,
      metadata: { ...(result?.metadata || {}) },
      time: { ...part.state.time, end: Date.now() },
    };
    emitPart(assistant, part);
    if (mutatesWorkspace(call.name) || result?.mutatedPaths?.length) emit(sessionId, 'file.edited', { paths: result?.mutatedPaths || ['.'] });
    return { content: toolOutputText(result), isError: false, metadata: result?.metadata || {}, mutatedPaths: result?.mutatedPaths || [] };
  } catch (err) {
    part.state = {
      ...part.state,
      status: 'error',
      output: `Error: ${err?.message || String(err)}`,
      time: { ...part.state.time, end: Date.now() },
    };
    emitPart(assistant, part);
    if (err?.name === 'AbortError' || controller.signal.aborted) throw err;
    return { content: `Error: ${err?.message || String(err)}`, isError: true, metadata: {}, mutatedPaths: [] };
  }
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

  try {
    const selected = await pickModel(ownerId, model);
    assistant.info.model = `${selected.providerID}/${selected.modelID}`;
    const history = listMessages(sessionId).filter((m) => m.id !== assistant.id);
    const frames = framesFromMessages(history, workspace);
    const strategy = createTurnStrategy(promptText(parts));
    const maxSteps = Math.max(1, Number(process.env.Z_AGENT_MAX_STEPS) || 32);
    let lastUsage = null;
    let gateReminders = 0;

    for (let step = 0; step < maxSteps; step++) {
      if (controller.signal.aborted) throw Object.assign(new Error('Turn cancelled'), { name: 'AbortError' });
      const live = liveTextSink(assistant);
      const response = await callModel(ownerId, selected, {
        system: [systemPrompt(), strategyGuidance(strategy), system || ''].filter(Boolean).join('\n\n'),
        frames: compactFrames(frames),
        tools: availableToolDefinitions(),
        signal: controller.signal,
        onTextDelta: (delta) => live.push(delta),
      });
      const streamedText = live.finish();
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
        assistant.time.completed = Date.now();
        assistant.info.finish = response.finish || 'stop';
        assistant.info.tokens = lastUsage ? {
          input: lastUsage.prompt_tokens ?? lastUsage.input_tokens ?? lastUsage.inputTokens ?? lastUsage.promptTokenCount,
          output: lastUsage.completion_tokens ?? lastUsage.output_tokens ?? lastUsage.outputTokens ?? lastUsage.candidatesTokenCount,
        } : undefined;
        assistant.info.strategy = {
          changed: strategy.changed,
          verificationAttempts: strategy.verificationAttempts,
          lastVerificationOk: strategy.lastVerificationOk,
          toolErrors: strategy.toolErrors,
        };
        assistant.info.time = { ...(assistant.info.time || {}), completed: assistant.time.completed };
        persistAssistant(assistant);
        updateTurn(sessionId, { lifecycle: 'completed', verdict: 'completed', since: Date.now(), reason: 'model_final' });
        emit(sessionId, 'session.idle', {});
        return assistant;
      }

      if (response.text && !streamedText) await emitText(assistant, response.text, 'text');
      frames.push({ role: 'assistant', content: response.text || '', toolCalls: calls });
      for (const call of calls) {
        const result = await executeCall(sessionId, assistant, call, controller, { ownerId, model: selected });
        observeTool(strategy, call, result);
        frames.push({ role: 'tool', callId: call.id, name: call.name, content: result.content, isError: result.isError });
      }
    }
    throw new Error(`Agent stopped after ${maxSteps} tool/model steps to prevent an infinite loop`);
  } catch (err) {
    const cancelled = controller.signal.aborted || err?.name === 'AbortError';
    assistant.time.completed = Date.now();
    assistant.info.finish = cancelled ? 'stop' : 'error';
    assistant.info.time = { ...(assistant.info.time || {}), completed: assistant.time.completed };
    if (!cancelled) assistant.info.error = { message: err?.message || String(err), name: err?.name || 'Error' };
    if (!cancelled && !(assistant.parts || []).some((p) => p.type === 'text')) await emitText(assistant, `Ошибка агента: ${err?.message || String(err)}`, 'text');
    persistAssistant(assistant);
    updateTurn(sessionId, { lifecycle: cancelled ? 'cancelled' : 'failed', verdict: cancelled ? 'cancelled' : 'failed', since: Date.now(), reason: err?.message || String(err) });
    emit(sessionId, 'session.idle', {});
    if (!cancelled) throw err;
    return assistant;
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
  for (const [id, waiter] of permissionWaiters) if (waiter.sessionId === sessionId) waiter.reject(Object.assign(new Error('Turn cancelled'), { name: 'AbortError' }));
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

export function answerPermission(sessionId, id, response) {
  if (!['once', 'always', 'reject'].includes(response)) return false;
  const p = getPermission(id);
  if (!p || p.sessionID !== sessionId || p.status !== 'pending') return false;
  resolvePermission(id, response);
  emit(sessionId, 'permission.responded', { id, response });
  permissionWaiters.get(id)?.resolve(response);
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
  alwaysAllowed.delete(sessionId);
  for (const key of activeActions.keys()) if (key.startsWith(`${sessionId}:`)) activeActions.delete(key);
  for (const [id, waiter] of questionWaiters) if (waiter.sessionId === sessionId) questionWaiters.delete(id);
  for (const [id, waiter] of permissionWaiters) if (waiter.sessionId === sessionId) permissionWaiters.delete(id);
  return true;
}

export function resetAgentStateForTests() {
  for (const active of activeTurns.values()) active.controller.abort();
  activeTurns.clear(); activeActions.clear(); questionWaiters.clear(); permissionWaiters.clear(); alwaysAllowed.clear();
}
