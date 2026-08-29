/**
 * Message persistence and streaming helpers extracted from agent orchestration.
 * Keeps agent.mjs focused on the turn state machine.
 */
import { partId } from '../ids.mjs';

export function persistAssistant(assistant, { putMessage, emit }) {
  putMessage(assistant);
  emit(assistant.sessionID, 'message.updated', { message: assistant });
}

export function emitPart(assistant, part, { putMessage, emit }) {
  const i = assistant.parts.findIndex((p) => p.id === part.id);
  if (i === -1) assistant.parts.push(part);
  else assistant.parts[i] = part;
  putMessage(assistant);
  emit(assistant.sessionID, 'message.part.updated', { messageID: assistant.id, part });
}

export async function emitText(assistant, text, type = 'text', { putMessage, emit }) {
  if (!text) return;
  const trimmed = String(text).trim();
  const last = assistant.parts[assistant.parts.length - 1];
  if (type === 'text' && last?.type === 'text' && String(last.text || '').trim() === trimmed) return;
  const part = { id: partId(), type, text: '' };
  assistant.parts.push(part);
  appendStreamedPart(assistant, part, trimmed, { putMessage, emit });
}

/**
 * Persist a finished text part exactly once.
 *
 * Tokens already reach the client over SSE while the provider streams, so the
 * database only needs the completed part. The previous implementation wrote the
 * whole assistant message back to SQLite after every single character, which
 * turned a 4 KB answer into ~4000 synchronous writes and blocked the event loop
 * for seconds on long replies.
 */
function appendStreamedPart(assistant, part, text, { putMessage, emit }) {
  part.text = text;
  putMessage(assistant);
  emit(assistant.sessionID, 'message.part.updated', { messageID: assistant.id, part });
}
