import { createReasoningSplitter } from '../reasoning-stream.mjs';
import { fetchJson, fetchSse, routedProviderTarget } from './transport.mjs';

/**
 * Some models emit stray NUL characters inside tool-call strings (for example
 * "tail\u0000 -n 3\u0000"). NUL is never valid in a command, path or text
 * argument and makes child_process reject the whole call, so the turn failed on
 * a glitch the user could not see or fix. Drop them before dispatch.
 */
export function stripNulChars(value) {
  if (typeof value === 'string') return value.includes('\u0000') ? value.replaceAll('\u0000', '') : value;
  if (Array.isArray(value)) return value.map(stripNulChars);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripNulChars(v)]));
  }
  return value;
}

const STREAM_ERROR_TYPE_STATUS = { overloaded_error: 529, rate_limit_error: 429, api_error: 500 };

/**
 * Providers can answer HTTP 200 and then report a failure inside the stream
 * (OpenRouter `{"error":{...}}`, Anthropic `{"type":"error",...}`). Ignoring
 * those events made a failed call look like a short, successful answer.
 * Returns an Error shaped like a normal provider failure so the usual
 * retry / interrupted-stream handling applies, or null for ordinary events.
 */
export function streamEventError(event) {
  if (!event || typeof event !== 'object') return null;
  const raw = event.type === 'error' ? (event.error ?? event) : event.error;
  if (!raw || (typeof raw !== 'object' && typeof raw !== 'string')) return null;
  const message = typeof raw === 'string' ? raw : String(raw.message || raw.type || 'Provider stream error');
  const err = new Error(message.slice(0, 500));
  err.providerResponse = true;
  err.body = event;
  const code = typeof raw === 'object' ? Number(raw.code ?? raw.status) : 0;
  if (Number.isInteger(code) && code >= 400 && code < 600) err.statusCode = code;
  else if (typeof raw === 'object' && STREAM_ERROR_TYPE_STATUS[raw.type]) err.statusCode = STREAM_ERROR_TYPE_STATUS[raw.type];
  return err;
}

/**
 * Report a tool call that is still being assembled so the UI can show its
 * card (name, path, the file body so far) while the model is writing it. This
 * is display-only: a failure here must never break the provider stream.
 */
function reportToolCall(onToolCall, payload) {
  if (typeof onToolCall !== 'function') return;
  try {
    onToolCall(payload);
  } catch {
    /* display aid only */
  }
}

export function parseToolArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (Object.hasOwn(raw, '_raw') && Object.keys(raw).length === 1) {
      return { ok: false, value: {}, raw: raw._raw };
    }
    return { ok: true, value: stripNulChars(raw) };
  }
  if (typeof raw !== 'string' || !raw.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, value: {}, raw };
    return { ok: true, value: stripNulChars(value) };
  } catch {
    return { ok: false, value: {}, raw };
  }
}

export function isIncompleteToolCall(call) {
  if (call?.incomplete) return true;
  const args = call?.arguments;
  return Boolean(args && typeof args === 'object' && Object.hasOwn(args, '_raw') && Object.keys(args).length === 1);
}

export function toolCallFromParsed(id, name, rawArgs) {
  const parsed = parseToolArguments(rawArgs);
  const call = { id, name, arguments: parsed.ok ? parsed.value : {} };
  if (!parsed.ok) call.incomplete = true;
  return call;
}

export function parseDataUrl(dataUrl) {
  const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(String(dataUrl || ''));
  if (!match) return null;
  const mediaType = match[1] || 'application/octet-stream';
  try {
    const data = match[2] ? match[3] : Buffer.from(decodeURIComponent(match[3]), 'utf8').toString('base64');
    return { mediaType, data, dataUrl: String(dataUrl) };
  } catch {
    return null;
  }
}

export function mediaNote(media) {
  return media?.name ? `[Attached file: ${media.name}]` : '[Attached file]';
}

export function openAiMessages(frames) {
  const out = [];
  for (const f of frames) {
    if (f.role === 'user') {
      const media = Array.isArray(f.media) ? f.media : [];
      if (media.length === 0) {
        out.push({ role: 'user', content: f.content || '' });
      } else {
        const content = [];
        if (f.content) content.push({ type: 'text', text: f.content });
        for (const item of media) {
          const parsed = parseDataUrl(item.dataUrl);
          if (parsed?.mediaType.startsWith('image/')) content.push({ type: 'image_url', image_url: { url: parsed.dataUrl } });
          else
            content.push({
              type: 'text',
              text: `${mediaNote(item)} The file is available in the workspace; inspect it with tools if needed (view_media shows images and video frames).`,
            });
        }
        out.push({ role: 'user', content });
      }
    } else if (f.role === 'assistant') {
      const msg = { role: 'assistant', content: f.content || null };
      if (f.reasoning) {
        msg.reasoning_content = f.reasoning;
      }
      if (f.toolCalls?.length)
        msg.tool_calls = f.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) },
        }));
      out.push(msg);
    } else if (f.role === 'tool') out.push({ role: 'tool', tool_call_id: f.callId, content: f.content });
  }
  return out;
}

// OpenRouter и похожие шлюзы без max_tokens резервируют максимум модели
// (например, 65536) и отказывают, если баланса хватает меньше:
// «You requested up to 65536 tokens, but can only afford 3666».
// Тогда повторяем с доступным лимитом и запоминаем его для модели.
const affordableCaps = new Map();
export function affordableTokens(err) {
  const text = `${err?.message || ''} ${JSON.stringify(err?.body || '')}`;
  const m = /can only afford (\d+)/i.exec(text);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function callOpenAI(resolved, opts) {
  const capKey = `${resolved?.spec?.baseURL || ''}|${resolved?.modelId || ''}`;
  let cap = affordableCaps.get(capKey) || 0;
  for (let attempt = 0; ; attempt++) {
    try {
      return await callOpenAIOnce(resolved, opts, cap);
    } catch (err) {
      const afford = affordableTokens(err);
      const next = Math.floor(afford * 0.95);
      if (!afford || attempt >= 2 || next < 256 || (cap && next >= cap)) throw err;
      cap = next;
      affordableCaps.set(capKey, cap);
    }
  }
}

async function callOpenAIOnce(
  resolved,
  { system, frames, tools, signal, onTextDelta, onToolCall, failFastRateLimit = false },
  maxTokens = 0,
) {
  const directUrl = `${resolved.spec.baseURL.replace(/\/$/, '')}/chat/completions`;
  const target = await routedProviderTarget(directUrl, resolved.trustedBaseURL);
  const request = {
    model: resolved.modelId,
    messages: [{ role: 'system', content: system }, ...openAiMessages(frames)],
    ...(maxTokens > 0 ? { max_tokens: maxTokens } : {}),
    ...(tools && tools.length > 0
      ? {
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
          tool_choice: 'auto',
        }
      : {}),
  };
  const headers = { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${resolved.key}` };
  if (typeof onTextDelta !== 'function') {
    const body = await fetchJson(target, { method: 'POST', headers, body: JSON.stringify(request) }, signal, { failFastRateLimit });
    const choice = body?.choices?.[0];
    const msg = choice?.message || {};
    const toolCalls = (msg.tool_calls || [])
      .map((c) => toolCallFromParsed(c.id || `call_${Math.random().toString(36).slice(2)}`, c.function?.name || '', c.function?.arguments))
      .filter((c) => c.name);
    let contentText = typeof msg.content === 'string' ? msg.content : '';
    if (!contentText) {
      for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
        if (typeof msg[key] === 'string' && msg[key]) {
          contentText = msg[key];
          break;
        }
      }
    }
    return { text: contentText, toolCalls, usage: body?.usage || null, finish: choice?.finish_reason || null, streamed: false };
  }

  const splitter = createReasoningSplitter(({ kind, text: chunk }) => onTextDelta(chunk, kind));
  let usage = null;
  let finish = null;
  const calls = new Map();
  const sse = await fetchSse(
    target,
    { method: 'POST', headers: { ...headers, accept: 'text/event-stream' }, body: JSON.stringify({ ...request, stream: true }) },
    signal,
    (event) => {
      const streamError = streamEventError(event);
      if (streamError) throw streamError;
      if (event?.usage) usage = event.usage;
      const choice = event?.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finish = choice.finish_reason;
      const delta = choice.delta || {};
      for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
        if (typeof delta[key] === 'string' && delta[key]) splitter.push(delta[key], 'reasoning');
      }
      if (typeof delta.content === 'string' && delta.content) splitter.push(delta.content, 'text');
      for (const piece of delta.tool_calls || []) {
        const index = Number.isInteger(piece.index) ? piece.index : calls.size;
        const current = calls.get(index) || { id: '', name: '', arguments: '' };
        if (piece.id) current.id = piece.id;
        if (piece.function?.name) current.name += piece.function.name;
        if (piece.function?.arguments) current.arguments += piece.function.arguments;
        calls.set(index, current);
        if (current.name) reportToolCall(onToolCall, { key: index, id: current.id, name: current.name, args: current.arguments });
      }
    },
    { failFastRateLimit },
  );
  splitter.flush();
  const { text: streamedText, reasoning } = splitter.snapshot();
  const toolCalls = [...calls.values()]
    .map((c, i) => toolCallFromParsed(c.id || `call_${Date.now()}_${i}`, c.name, c.arguments))
    .filter((c) => c.name);
  if (!streamedText && reasoning && toolCalls.length === 0) {
    return { text: reasoning, toolCalls, usage, finish, streamed: true, textFromReasoning: true, interrupted: Boolean(sse?.interrupted) };
  }
  return { text: streamedText, toolCalls, usage, finish, streamed: true, interrupted: Boolean(sse?.interrupted) };
}

export function anthropicMessages(frames) {
  const out = [];
  for (const f of frames) {
    if (f.role === 'user') {
      const blocks = [];
      if (f.content) blocks.push({ type: 'text', text: f.content });
      for (const item of f.media || []) {
        const parsed = parseDataUrl(item.dataUrl);
        if (!parsed) continue;
        if (parsed.mediaType.startsWith('image/')) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data } });
        } else if (parsed.mediaType === 'application/pdf') {
          blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: parsed.data } });
        } else blocks.push({ type: 'text', text: `${mediaNote(item)} The file is available in the workspace.` });
      }
      out.push({ role: 'user', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
    } else if (f.role === 'assistant') {
      const blocks = [];
      if (f.content) blocks.push({ type: 'text', text: f.content });
      for (const c of f.toolCalls || []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments || {} });
      out.push({ role: 'assistant', content: blocks });
    } else if (f.role === 'tool') {
      const prev = out[out.length - 1];
      const block = { type: 'tool_result', tool_use_id: f.callId, content: f.content, is_error: Boolean(f.isError) };
      if (prev?.role === 'user' && Array.isArray(prev.content) && prev.content.every((x) => x.type === 'tool_result'))
        prev.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

export async function callAnthropic(resolved, { system, frames, tools, signal, onTextDelta, onToolCall, failFastRateLimit = false }) {
  const directUrl = `${resolved.spec.baseURL.replace(/\/$/, '')}/messages`;
  const target = await routedProviderTarget(directUrl, resolved.trustedBaseURL);
  const request = {
    model: resolved.modelId,
    max_tokens: 8192,
    system,
    messages: anthropicMessages(frames),
    tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })),
  };
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-api-key': resolved.key,
    'anthropic-version': '2023-06-01',
  };
  if (typeof onTextDelta !== 'function') {
    const body = await fetchJson(target, { method: 'POST', headers, body: JSON.stringify(request) }, signal, { failFastRateLimit });
    const content = Array.isArray(body?.content) ? body.content : [];
    return {
      text: content
        .filter((b) => b.type === 'text')
        .map((b) => b.text || '')
        .join(''),
      toolCalls: content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, arguments: b.input || {} })),
      usage: body?.usage || null,
      finish: body?.stop_reason || null,
      streamed: false,
    };
  }

  const splitter = createReasoningSplitter(({ kind, text: chunk }) => onTextDelta(chunk, kind));
  let usage = null;
  let finish = null;
  const calls = new Map();
  const sse = await fetchSse(
    target,
    { method: 'POST', headers: { ...headers, accept: 'text/event-stream' }, body: JSON.stringify({ ...request, stream: true }) },
    signal,
    (event) => {
      const streamError = streamEventError(event);
      if (streamError) throw streamError;
      if (event?.type === 'message_start' && event.message?.usage) usage = event.message.usage;
      if (event?.type === 'message_delta') {
        if (event.delta?.stop_reason) finish = event.delta.stop_reason;
        if (event.usage) usage = { ...(usage || {}), ...event.usage };
      }
      if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
        const started = {
          id: event.content_block.id,
          name: event.content_block.name,
          baseInput: event.content_block.input || {},
          partial: '',
        };
        calls.set(event.index, started);
        if (started.name) reportToolCall(onToolCall, { key: event.index, id: started.id, name: started.name, args: started.baseInput });
      }
      if (event?.type === 'content_block_delta') {
        if (event.delta?.type === 'text_delta' && event.delta.text) splitter.push(event.delta.text, 'text');
        if (event.delta?.type === 'thinking_delta' && event.delta.thinking) splitter.push(event.delta.thinking, 'reasoning');
        if (event.delta?.type === 'input_json_delta') {
          const current = calls.get(event.index) || { id: `call_${Date.now()}_${event.index}`, name: '', baseInput: {}, partial: '' };
          current.partial += event.delta.partial_json || '';
          calls.set(event.index, current);
          if (current.name)
            reportToolCall(onToolCall, {
              key: event.index,
              id: current.id,
              name: current.name,
              args: current.partial || current.baseInput,
            });
        }
      }
    },
    { failFastRateLimit },
  );
  splitter.flush();
  const toolCalls = [...calls.values()].map((c) => toolCallFromParsed(c.id, c.name, c.partial || c.baseInput || {})).filter((c) => c.name);
  return { text: splitter.snapshot().text, toolCalls, usage, finish, streamed: true, interrupted: Boolean(sse?.interrupted) };
}

export function googleContents(frames) {
  const contents = [];
  for (const f of frames) {
    if (f.role === 'user') {
      const parts = [];
      if (f.content) parts.push({ text: f.content });
      for (const item of f.media || []) {
        const parsed = parseDataUrl(item.dataUrl);
        if (!parsed) continue;
        if (parsed.mediaType.startsWith('image/')) {
          parts.push({ inlineData: { mimeType: parsed.mediaType, data: parsed.data } });
        } else parts.push({ text: `${mediaNote(item)} The file is available in the workspace.` });
      }
      contents.push({ role: 'user', parts: parts.length ? parts : [{ text: '' }] });
    } else if (f.role === 'assistant') {
      const parts = [];
      if (f.content) parts.push({ text: f.content });
      for (const c of f.toolCalls || []) parts.push({ functionCall: { name: c.name, args: c.arguments || {} } });
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
    } else if (f.role === 'tool') {
      contents.push({ role: 'function', parts: [{ functionResponse: { name: f.name || 'tool', response: { content: f.content } } }] });
    }
  }
  return contents;
}

export async function callGoogle(resolved, { system, frames, tools, signal, onTextDelta, onToolCall, failFastRateLimit = false }) {
  const action = typeof onTextDelta === 'function' ? 'streamGenerateContent' : 'generateContent';
  const directUrl = `${resolved.spec.baseURL.replace(/\/$/, '')}/models/${resolved.modelId}:${action}`;
  const target = await routedProviderTarget(directUrl, resolved.trustedBaseURL);
  const request = {
    contents: googleContents(frames),
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    tools: tools.length
      ? [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }]
      : undefined,
  };
  const headers = { 'content-type': 'application/json', accept: 'application/json', 'x-goog-api-key': resolved.key };

  if (typeof onTextDelta !== 'function') {
    const body = await fetchJson(target, { method: 'POST', headers, body: JSON.stringify(request) }, signal, { failFastRateLimit });
    const candidate = body?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const text = parts
      .filter((p) => p.text)
      .map((p) => p.text)
      .join('');
    const toolCalls = parts
      .filter((p) => p.functionCall)
      .map((p, i) => toolCallFromParsed(`call_${Date.now()}_${i}`, p.functionCall.name, p.functionCall.args))
      .filter((c) => c.name);
    return { text, toolCalls, usage: body?.usageMetadata || null, finish: candidate?.finishReason || null, streamed: false };
  }

  const splitter = createReasoningSplitter(({ kind, text: chunk }) => onTextDelta(chunk, kind));
  let usage = null;
  let finish = null;
  const toolCalls = [];
  const sseUrl = `${target.url}${target.url.includes('?') ? '&' : '?'}alt=sse`;
  const sseTarget = {
    ...target,
    url: sseUrl,
    fallback: target.fallback
      ? { ...target.fallback, url: `${target.fallback.url}${target.fallback.url.includes('?') ? '&' : '?'}alt=sse` }
      : null,
  };
  const sse = await fetchSse(
    sseTarget,
    { method: 'POST', headers: { ...headers, accept: 'text/event-stream' }, body: JSON.stringify(request) },
    signal,
    (event) => {
      const streamError = streamEventError(event);
      if (streamError) throw streamError;
      if (event?.usageMetadata) usage = event.usageMetadata;
      const candidate = event?.candidates?.[0];
      if (candidate?.finishReason) finish = candidate.finishReason;
      for (const p of candidate?.content?.parts || []) {
        if (p.text) splitter.push(p.text, 'text');
        if (p.functionCall) {
          const call = toolCallFromParsed(`call_${Date.now()}_${toolCalls.length}`, p.functionCall.name, p.functionCall.args);
          toolCalls.push(call);
          if (call.name) reportToolCall(onToolCall, { key: toolCalls.length - 1, id: call.id, name: call.name, args: call.arguments });
        }
      }
    },
    { failFastRateLimit },
  );
  splitter.flush();
  const { text: streamedText } = splitter.snapshot();
  return {
    text: streamedText,
    toolCalls: toolCalls.filter((c) => c.name),
    usage,
    finish,
    streamed: true,
    interrupted: Boolean(sse?.interrupted),
  };
}

export async function callOllama(resolved, { system, frames, signal, onTextDelta, failFastRateLimit = false }) {
  const directUrl = `${resolved.spec.baseURL.replace(/\/$/, '')}/api/chat`;
  const target = await routedProviderTarget(directUrl, resolved.trustedBaseURL);
  const messages = [
    { role: 'system', content: system },
    ...frames.map((f) => ({ role: f.role === 'assistant' ? 'assistant' : 'user', content: f.content || '' })),
  ];
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (resolved.key) headers.authorization = `Bearer ${resolved.key}`;

  if (typeof onTextDelta !== 'function') {
    const body = await fetchJson(
      target,
      { method: 'POST', headers, body: JSON.stringify({ model: resolved.modelId, messages, stream: false }) },
      signal,
      { failFastRateLimit },
    );
    return { text: body?.message?.content || '', toolCalls: [], usage: null, finish: body?.done ? 'stop' : null, streamed: false };
  }

  const splitter = createReasoningSplitter(({ kind, text: chunk }) => onTextDelta(chunk, kind));
  let finish = null;
  const sse = await fetchSse(
    target,
    { method: 'POST', headers, body: JSON.stringify({ model: resolved.modelId, messages, stream: true }) },
    signal,
    (event) => {
      if (event?.message?.content) splitter.push(event.message.content, 'text');
      if (event?.done) finish = 'stop';
    },
    { failFastRateLimit },
  );
  splitter.flush();
  const { text: streamedText } = splitter.snapshot();
  return { text: streamedText, toolCalls: [], usage: null, finish, streamed: true, interrupted: Boolean(sse?.interrupted) };
}
