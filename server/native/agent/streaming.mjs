import { emit } from '../events.mjs';
import { partId } from '../ids.mjs';
import { putMessage } from '../store.mjs';
import { createReasoningSplitter } from '../reasoning-stream.mjs';

export function sanitizeAssistantParts(assistant) {
  if (!assistant || !Array.isArray(assistant.parts)) return;
  for (const part of assistant.parts) {
    if (part.type === 'text' && typeof part.text === 'string') {
      part.text = part.text.replace(/<\/?(?:think|thought|thinking)>/gi, '').trim();
    }
  }
}

export function liveTextSink(assistant) {
  let current = null;
  let streamedText = false;
  let streamedReasoning = false;

  const openPart = (type) => {
    const part = { id: partId(), type, text: '' };
    assistant.parts.push(part);
    emit(assistant.sessionID, 'message.part.updated', { messageID: assistant.id, part });
    return part;
  };

  const applySegment = ({ kind, text: chunk, replace = false }) => {
    if (!chunk) return;
    if (!current || current.type !== kind) current = openPart(kind);
    if (kind === 'reasoning') streamedReasoning = streamedReasoning || Boolean(chunk.trim());
    else streamedText = streamedText || Boolean(chunk.trim());
    if (replace) {
      current.text = chunk;
      emit(assistant.sessionID, 'message.part.updated', { messageID: assistant.id, part: current });
      return;
    }
    current.text += chunk;
    emit(assistant.sessionID, 'message.part.delta', { messageID: assistant.id, partID: current.id, field: 'text', delta: chunk });
  };

  const splitter = createReasoningSplitter(applySegment);

  return {
    push(delta, explicitType = null) {
      splitter.push(delta, explicitType);
    },
    finish() {
      splitter.flush();
      sanitizeAssistantParts(assistant);
      if (current) putMessage(assistant);
      return { text: streamedText, reasoning: streamedReasoning };
    },
  };
}
