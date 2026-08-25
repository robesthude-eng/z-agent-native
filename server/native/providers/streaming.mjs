import { createReasoningSplitter } from '../reasoning-stream.mjs';
import { fetchJson, fetchSse, routedProviderTarget } from './transport.mjs';

export function parseToolArguments(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (Object.hasOwn(raw, '_raw') && Object.keys(raw).length === 1) {
      return { ok: false, value: {}, raw: raw._raw };
    }
    return { ok: true, value: raw };
  }
  if (typeof raw !== 'string' || !raw.trim()) return { ok: true, value: {} };
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, value: {}, raw };
    return { ok: true, value };
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
  } catch { return null; }
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
          else content.push({ type: 'text', text: `${mediaNote(item)} The file is available in the workspace; inspect it with tools if needed.` });
        }
        out.push({ role: 'user', content });
      }
    } else if (f.role === 'assistant') {
      const msg = { role: 'assistant', content: f.content || null };
      if (f.toolCalls?.length) msg.tool_calls = f.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments || {}) } }));
      out.push(msg);
    } else if (f.role === 'tool') out.push({ role: 'tool', tool_call_id: f.callId, content: f.content });
  }
  return out;
}

export async function callOpenAI(resolved, { system, frames, tools, signal, onTextDelta, failFastRateLimit = false }) {
  const directUrl = `${resolved.spec.baseURL.replace(/\/$/, '')}/chat/completions`;
  const target = await routedProviderTarget(directUrl, resolved.trustedBaseURL);
  const request = {
    model: resolved.modelId,
    messages: [{ role: 'system', content: system }, ...openAiMessages(frames)],
    ...(tools && tools.length > 0 ? {
      tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
      tool_choice: 'auto',
    } : {}),
  };
  const headers = { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${resolved.key}` };
  if (typeof onTextDelta !== 'function') {
    const body = await fetchJson(target, { method: 'POST', headers, body: JSON.stringify(request) }, signal, { failFastRateLimit });
    const choice = body?.choices?.[0];
    const msg = choice?.message || {};
    const toolCalls = (msg.tool_calls || []).map((c) => toolCallFromParsed(c.id || `call_${Math.random().toString(36).slice(2)}`, c.function?.name || '', c.function?.arguments)).filter((c) => c.name);
    let contentText = typeof msg.content === 'string' ? msg.content : '';
    if (!contentText) {
      for (const key of ['reasoning_content', 'reasoning', 'thinking']) {
        if (typeof msg[key] === 'string' && msg[key]) { contentText = msg[key]; break; }
      }
    }
    return { text: contentText, toolCalls, usage: body?.usage || null, finish: choice?.finish_reason || null, streamed: false };
  }

  const splitter = createReasoningSplitter(({ kind, text: chunk }) => onTextDelta(chunk, kind));
  let usage = null;
  let finish = null;
  const calls = new Map();
  await fetchSse(target, { method: 'POST', headers: { ...headers, accept: 'text/event-stream' }, body: JSON.stringify({ ...request, stream: true }) }, signal, (event) => {
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
    }
  }, { failFastRateLimit });
  splitter.flush();
  const { text: streamedText, reasoning } = splitter.snapshot();
  const toolCalls = [...calls.values()].map((c, i) => toolCallFromParsed(c.id || `call_${Date.now()}_${i}`, c.name, c.arguments)).filter((c) => c.name);
  if (!streamedText && reasoning && toolCalls.length === 0) {
    return { text: reasoning, toolCalls, usage, finish, streamed: true, textFromReasoning: true };
  }
  return { text: streamedText, toolCalls, usage, finish, streamed: true };
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
      if (prev?.role === 'user' && Array.isArray(prev.content) && prev.content.every((x) => x.type === 'tool_result')) prev.content.push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
}

export async function callAnthropic(resolved, { system, frames, tools, signal, onTextDelta, failFastRateLimit = false }) {
  const directUrl = `${resolved.spec.baseURL.replace(/\/$/, '')}/messages`;
  const target = await routedProviderTarget(directUrl, resolved.trustedBaseURL);
  const request = { model: resolved.modelId, max_tokens: 8192, system, messages: anthropicMessages(frames), tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) };
  const headers = { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': resolved.key, 'anthropic-version': '2023-06-01' };
  if (typeof onTextDelta !== 'function') {
    const body = await fetchJson(target, { method: 'POST', headers, body: JSON.stringify(request) }, signal, { failFastRateLimit });
    const content = Array.isArray(body?.content) ? body.content : [];
    const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('');
    const toolCalls = content.filter((c) => c.type === 'tool_use').map((c) => toolCallFromParsed(c.id, c.name, c.input)).filter((c) => c.name);
    return { text, toolCalls, usage: body?.usage || null, finish: body?.stop_reason || null, streamed: false };
  }

  const splitter = createReasoningSplitter(({ kind, text: chunk }) => onTextDelta(chunk, kind));
  let usage = null;
  let finish = null;
  let currentTool = null;
  const toolCalls = [];
  await fetchSse(target, { method: 'POST', headers: { ...headers, accept: 'text/event-stream' }, body: JSON.stringify({ ...request, stream: true }) }, signal, (event) => {
    if (event?.type === 'message_start' && event.message?.usage) usage = event.message.usage;
    if (event?.type === 'message_delta') {
      if (event.delta?.stop_reason) finish = event.delta.stop_reason;
      if (event.usage) usage = { ...(usage || {}), ...event.usage };
    }
    if (event?.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
      currentTool = { id: event.content_block.id, name: event.content_block.name, json: '' };
    }
    if (event?.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta') splitter.push(event.delta.text, 'text');
      if (event.delta?.type === 'thinking_delta') splitter.push(event.delta.thinking, 'reasoning');
      if (event.delta?.type === 'input_json_delta' && currentTool) currentTool.json += event.delta.partial_json;
    }
    if (event?.type === 'content_block_stop' && currentTool) {
      toolCalls.push(toolCallFromParsed(currentTool.id || `call_${Date.now()}_${toolCalls.length}`, currentTool.name, currentTool.json));
      currentTool = null;
    }
  }, { failFastRateLimit });
  splitter.flush();
  const { text: streamedText } = splitter.snapshot();
  return { text: streamedText, toolCalls: toolCalls.filter((c) => c.name), usage, finish, streamed: true };
}

export function googleContents(frames) {
  const contents = [];
  for (const f of frames) {
    if (f.role === 'user') {
      const parts = [];
      if (f.content) parts.push({ text: f.content });
      for (const item of f.media || []) {
        const parsed = parseDataUrl(item.dataUrl);
        if (parsed?.mediaType.startsWith('image/')) {
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

export async function callGoogle(resolved, { system, frames, tools, signal, onTextDelta, failFastRateLimit = false }) {
  const action = typeof onTextDelta === 'function' ? 'streamGenerateContent' : 'generateContent';
  const directUrl = `${resolved.spec.baseURL.replace(/\/$/, '')}/models/${resolved.modelId}:${action}`;
  const target = await routedProviderTarget(directUrl, resolved.trustedBaseURL);
  const request = {
    contents: googleContents(frames),
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    tools: tools.length ? [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }] : undefined,
  };
  const headers = { 'content-type': 'application/json', accept: 'application/json', 'x-goog-api-key': resolved.key };

  if (typeof onTextDelta !== 'function') {
    const body = await fetchJson(target, { method: 'POST', headers, body: JSON.stringify(request) }, signal, { failFastRateLimit });
    const candidate = body?.candidates?.[0];
    const parts = candidate?.content?.parts || [];
    const text = parts.filter((p) => p.text).map((p) => p.text).join('');
    const toolCalls = parts.filter((p) => p.functionCall).map((p, i) => toolCallFromParsed(`call_${Date.now()}_${i}`, p.functionCall.name, p.functionCall.args)).filter((c) => c.name);
    return { text, toolCalls, usage: body?.usageMetadata || null, finish: candidate?.finishReason || null, streamed: false };
  }

  const splitter = createReasoningSplitter(({ kind, text: chunk }) => onTextDelta(chunk, kind));
  let usage = null;
  let finish = null;
  const toolCalls = [];
  const sseUrl = `${target.url}${target.url.includes('?') ? '&' : '?'}alt=sse`;
  const sseTarget = { ...target, url: sseUrl, fallback: target.fallback ? { ...target.fallback, url: `${target.fallback.url}${target.fallback.url.includes('?') ? '&' : '?'}alt=sse` } : null };
  await fetchSse(sseTarget, { method: 'POST', headers: { ...headers, accept: 'text/event-stream' }, body: JSON.stringify(request) }, signal, (event) => {
    if (event?.usageMetadata) usage = event.usageMetadata;
    const candidate = event?.candidates?.[0];
    if (candidate?.finishReason) finish = candidate.finishReason;
    for (const p of candidate?.content?.parts || []) {
      if (p.text) splitter.push(p.text, 'text');
      if (p.functionCall) toolCalls.push(toolCallFromParsed(`call_${Date.now()}_${toolCalls.length}`, p.functionCall.name, p.functionCall.args));
    }
  }, { failFastRateLimit });
  splitter.flush();
  const { text: streamedText } = splitter.snapshot();
  return { text: streamedText, toolCalls: toolCalls.filter((c) => c.name), usage, finish, streamed: true };
}

export async function callOllama(resolved, { system, frames, signal, onTextDelta, failFastRateLimit = false }) {
  const directUrl = `${resolved.spec.baseURL.replace(/\/$/, '')}/api/chat`;
  const target = await routedProviderTarget(directUrl, resolved.trustedBaseURL);
  const messages = [{ role: 'system', content: system }, ...frames.map((f) => ({ role: f.role === 'assistant' ? 'assistant' : 'user', content: f.content || '' }))];
  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  if (resolved.key) headers.authorization = `Bearer ${resolved.key}`;

  if (typeof onTextDelta !== 'function') {
    const body = await fetchJson(target, { method: 'POST', headers, body: JSON.stringify({ model: resolved.modelId, messages, stream: false }) }, signal, { failFastRateLimit });
    return { text: body?.message?.content || '', toolCalls: [], usage: null, finish: body?.done ? 'stop' : null, streamed: false };
  }

  const splitter = createReasoningSplitter(({ kind, text: chunk }) => onTextDelta(chunk, kind));
  let finish = null;
  await fetchSse(target, { method: 'POST', headers, body: JSON.stringify({ model: resolved.modelId, messages, stream: true }) }, signal, (event) => {
    if (event?.message?.content) splitter.push(event.message.content, 'text');
    if (event?.done) finish = 'stop';
  }, { failFastRateLimit });
  splitter.flush();
  const { text: streamedText } = splitter.snapshot();
  return { text: streamedText, toolCalls: [], usage: null, finish, streamed: true };
}
