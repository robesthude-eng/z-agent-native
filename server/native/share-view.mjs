// Публичное представление чата по ссылке: только текст реплик и имена
// инструментов. Вывод команд, аргументы, рассуждения и вложения наружу не
// попадают — в них бывают пути, ключи и содержимое файлов.
import { listMessages } from './store.mjs';

const MAX_MESSAGES = 2000;
const MAX_TEXT = 200_000;

function publicParts(parts) {
  const out = [];
  for (const part of Array.isArray(parts) ? parts : []) {
    if (!part || typeof part !== 'object' || part.synthetic === true) continue;
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
      out.push({ type: 'text', text: part.text.slice(0, MAX_TEXT) });
    } else if (part.type === 'tool') {
      const tool = typeof part.tool === 'string' ? part.tool.slice(0, 64) : 'tool';
      const status = typeof part.state === 'object' && part.state ? String(part.state.status || '') : '';
      out.push({ type: 'tool', tool, status: status === 'error' ? 'error' : 'done' });
    }
  }
  return out;
}

export function publicChatView(share) {
  const messages = [];
  for (const m of listMessages(share.sessionId)) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const parts = publicParts(m.parts);
    if (!parts.length) continue;
    messages.push({ id: m.id, role: m.role, time: m.time?.created || 0, parts });
    if (messages.length >= MAX_MESSAGES) break;
  }
  return { title: share.title, created: share.created, updated: share.updated, messages };
}
