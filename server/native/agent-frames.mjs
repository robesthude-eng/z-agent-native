// Prompt assembly: chat history and user parts -> model frames, including attachment media.
// Extracted from agent.mjs so the orchestrator keeps only turn lifecycle logic.
import fs from 'node:fs';
import path from 'node:path';
import { safeWorkspacePath } from './security.mjs';

const SYSTEM_FILE = new URL('../system-instruction.txt', import.meta.url);

let cachedSystem = null;

export function systemPrompt() {
  if (cachedSystem == null) cachedSystem = fs.readFileSync(SYSTEM_FILE, 'utf8');
  return cachedSystem;
}

export function textParts(message) {
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

export function framesFromMessages(messages, workspace) {
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

export function userPartsFromPrompt(parts, workspace) {
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

export function promptText(parts) {
  return (Array.isArray(parts) ? parts : []).filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n\n').trim();
}
