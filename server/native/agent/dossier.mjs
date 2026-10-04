// «Досье задачи» для длинных чатов. Когда история не помещается в контекст,
// обычное сжатие просто выкидывает старые реплики — и агент забывает цель,
// принятые решения и уже проверенное. Здесь старая часть переписки один раз
// пересказывается моделью в структурированное досье (цель, решения, пути,
// состояние, предпочтения), а модели уходит досье + свежие сообщения.
// Досье обновляется инкрементально, когда снова накапливается много нового.
import fs from 'node:fs';
import path from 'node:path';
import { callModelAutopilot } from '../autopilot.mjs';
import { DATA_DIR } from '../config.mjs';
import { contextWeight } from '../context.mjs';

const DIR = path.join(DATA_DIR, 'project-context');
export const DOSSIER_TRIGGER_CHARS = Number(process.env.Z_AGENT_DOSSIER_TRIGGER_CHARS) || 220_000;
const KEEP_RECENT_CHARS = 90_000;
const MIN_KEEP_USER_MESSAGES = 2;
const MAX_SUMMARY_INPUT = 160_000;
const TOOL_OUTPUT_CLIP = 700;

function fileFor(sessionId) {
  if (!/^ses_[A-Za-z0-9]+$/.test(String(sessionId || ''))) throw new Error('Invalid session id');
  return path.join(DIR, `${sessionId}.dossier.json`);
}

export function readDossier(sessionId) {
  try { return JSON.parse(fs.readFileSync(fileFor(sessionId), 'utf8')); } catch { return null; }
}

function writeDossier(sessionId, value) {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const file = fileFor(sessionId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function clearDossier(sessionId) {
  try { fs.rmSync(fileFor(sessionId), { force: true }); } catch {}
}

function clip(text, max) {
  const s = String(text || '');
  return s.length <= max ? s : `${s.slice(0, Math.floor(max * 0.7))} …[${s.length - max} chars]… ${s.slice(-Math.floor(max * 0.3))}`;
}

/** Текстовая расшифровка сообщений для пересказа (вывод инструментов урезан). */
export function transcriptOf(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'user') {
      const text = (m.parts || []).filter((p) => p?.type === 'text').map((p) => p.text).join('\n').trim();
      if (text) out.push(`USER: ${clip(text, 6000)}`);
      continue;
    }
    if (m.role !== 'assistant') continue;
    for (const p of m.parts || []) {
      if (p?.type === 'text' && String(p.text || '').trim()) out.push(`AGENT: ${clip(p.text, 4000)}`);
      if (p?.type === 'tool' && p.tool && p.tool !== 'review') {
        const st = p.state && typeof p.state === 'object' ? p.state : {};
        const input = st.input && typeof st.input === 'object' ? JSON.stringify(st.input) : '';
        const output = typeof st.output === 'string' ? st.output : '';
        out.push(`TOOL ${p.tool}${st.status === 'error' ? ' (error)' : ''}: ${clip(input, 500)}${output ? `\n  → ${clip(output, TOOL_OUTPUT_CLIP)}` : ''}`);
      }
    }
  }
  return out.join('\n');
}

/**
 * Точка разреза: всё до неё уходит в досье. Свежий хвост — последние
 * сообщения на ~KEEP_RECENT_CHARS, но не меньше двух реплик пользователя;
 * разрез всегда перед сообщением пользователя, чтобы не рвать пары
 * вызов/результат инструмента.
 */
export function chooseCut(messages, framesFor) {
  let users = 0;
  let cut = -1;
  let tail = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    // Вес считаем по сообщению отдельно: frames одного сообщения не зависят от соседних.
    tail += contextWeight(framesFor([messages[i]]));
    if (messages[i].role !== 'user') continue;
    users += 1;
    cut = i;
    if (users >= MIN_KEEP_USER_MESSAGES && tail >= KEEP_RECENT_CHARS) break;
  }
  return cut > 0 ? cut : -1;
}

const SYSTEM = [
  'You maintain a compact "task dossier" for a long conversation between a user and an autonomous coding/ops agent, so the agent can keep working without the old messages.',
  'Write in Russian. Be specific: exact file paths, commands, hostnames, versions, ports, config keys, error messages and their fixes. No fluff. Never include secrets (passwords, tokens, keys) — write "[секрет]" instead.',
  'Structure (Markdown headings, omit empty sections):',
  '## Цель и контекст — what the user wants overall and why',
  '## Требования и предпочтения пользователя — explicit rules, corrections, style',
  '## Что сделано — chronological key results with paths',
  '## Текущее состояние — what works now, what is deployed/running, where things are',
  '## Принятые решения — choices and their reasons; rejected approaches and why',
  '## Проблемы и уроки — errors hit and how they were solved',
  '## Открытые вопросы и следующие шаги',
  'If a previous dossier is given, merge the new transcript into it (update, do not just append; drop obsolete details). Max ~1800 words.',
].join('\n');

export async function summarize({ ownerId, modelPlan, previous, transcript, signal }) {
  const content = [
    previous ? `# Previous dossier\n${previous}` : '',
    `# Transcript to fold in\n${clip(transcript, MAX_SUMMARY_INPUT)}`,
  ].filter(Boolean).join('\n\n');
  const res = await callModelAutopilot(ownerId, modelPlan, { system: SYSTEM, frames: [{ role: 'user', content }], tools: [], signal });
  const text = String(res?.text || '').trim();
  return text.length > 200 ? text : null;
}

export function dossierPreamble(summary, count) {
  return `[Runtime: task dossier] The ${count} earliest messages of this chat were condensed into the dossier below to fit the context window. It is your memory of that earlier work; trust it, and re-inspect files/state when you need exact details.\n\n${summary}\n\n[End of dossier — the conversation continues below]`;
}

/**
 * Возвращает frames для модели: при необходимости — досье + свежий хвост.
 * Ошибки пересказа не ломают ход: тогда работает обычное сжатие.
 */
export async function framesWithDossier({ sessionId, ownerId, modelPlan, history, framesFor, signal, enabled = true, onStatus = null }) {
  const full = framesFor(history);
  if (!enabled || contextWeight(full) <= DOSSIER_TRIGGER_CHARS) {
    // Чат короткий, но досье могло остаться от прошлого — применяем, если его граница ещё в истории.
    const existing = enabled ? readDossier(sessionId) : null;
    return existing ? applyExisting(existing, history, framesFor) || full : full;
  }
  const existing = readDossier(sessionId);
  const cut = chooseCut(history, framesFor);
  if (cut <= 0) return full;
  const cutId = history[cut].id;
  if (existing?.uptoMessageId) {
    const idx = history.findIndex((m) => m.id === existing.uptoMessageId);
    const applied = applyExisting(existing, history, framesFor);
    // Хвост после досье ещё помещается — пересказ не нужен.
    if (applied && contextWeight(applied) <= DOSSIER_TRIGGER_CHARS) return applied;
    if (idx >= 0 && idx >= cut) return applied || full;
  }
  const startIdx = existing?.uptoMessageId ? Math.max(0, history.findIndex((m) => m.id === existing.uptoMessageId)) : 0;
  const older = history.slice(startIdx, cut);
  if (!older.length) return applyExisting(existing, history, framesFor) || full;
  try {
    onStatus?.('dossier');
    const summary = await summarize({ ownerId, modelPlan, previous: existing?.summary || '', transcript: transcriptOf(older), signal });
    if (!summary) return applyExisting(existing, history, framesFor) || full;
    const next = { uptoMessageId: cutId, condensed: cut, summary, updatedAt: Date.now() };
    writeDossier(sessionId, next);
    return applyExisting(next, history, framesFor) || full;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    console.warn(`[dossier] ${sessionId}: ${err?.message || err}`);
    return applyExisting(existing, history, framesFor) || full;
  }
}

function applyExisting(dossier, history, framesFor) {
  if (!dossier?.uptoMessageId || !dossier.summary) return null;
  const idx = history.findIndex((m) => m.id === dossier.uptoMessageId);
  if (idx <= 0) return null;
  const frames = framesFor(history.slice(idx));
  const first = frames.findIndex((f) => f.role === 'user');
  if (first < 0) return null;
  frames[first] = { ...frames[first], content: `${dossierPreamble(dossier.summary, idx)}\n\n${frames[first].content || ''}` };
  return frames.slice(first);
}
