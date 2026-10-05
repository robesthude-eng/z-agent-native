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
 * Make the reasoning streamed during the final step the visible reply.
 *
 * Some OpenAI-compatible relays deliver a model's whole final answer through
 * the reasoning channel. The turn loop then printed that answer again as a new
 * text part, so the user saw the same reply twice: once in the thinking card
 * and once as the message, and the next turn received it twice as history.
 * Converting the streamed part in place keeps exactly one copy.
 *
 * Returns false when this step streamed no reasoning part to convert.
 */
export function promoteReasoningToText(assistant, streamedParts, text, { putMessage, emit }) {
  const answer = String(text || '').replace(/<\/?(?:think|thought|thinking)>/gi, '').trim();
  const reasoning = (streamedParts || []).filter((part) => part?.type === 'reasoning' && assistant.parts.includes(part));
  if (!answer || reasoning.length === 0) return false;
  const target = reasoning[reasoning.length - 1];
  for (const part of reasoning.slice(0, -1)) {
    assistant.parts.splice(assistant.parts.indexOf(part), 1);
    // An empty part is not rendered, so the client drops the extra card too.
    emit(assistant.sessionID, 'message.part.updated', { messageID: assistant.id, part: { ...part, text: '' } });
  }
  target.type = 'text';
  target.text = answer;
  putMessage(assistant);
  emit(assistant.sessionID, 'message.part.updated', { messageID: assistant.id, part: target });
  return true;
}

/**
 * Fold a draft answer into the collapsed "thinking" card.
 *
 * When the independent reviewer sends the agent back to fix problems, the
 * draft answer has already been streamed to the user. The agent then writes a
 * new final answer, so the chat showed two near-identical summaries. Demoting
 * the superseded draft keeps its text (nothing is lost if the turn later ends
 * abnormally) but leaves exactly one visible reply.
 *
 * Returns the number of parts demoted.
 */
export function demoteDraftTextToReasoning(assistant, streamedParts, { putMessage, emit }) {
  const drafts = (streamedParts || []).filter((part) => part?.type === 'text' && assistant.parts.includes(part) && String(part.text || '').trim());
  if (drafts.length === 0) return 0;
  for (const part of drafts) {
    part.type = 'reasoning';
    emit(assistant.sessionID, 'message.part.updated', { messageID: assistant.id, part });
  }
  putMessage(assistant);
  return drafts.length;
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
