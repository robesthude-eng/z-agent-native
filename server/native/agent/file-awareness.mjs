// «Не перезаписывай вслепую»: `write` поверх существующего непустого файла, которого агент
// в этом чате ещё не видел (не читал, не создавал, не правил, не открывал cat/sed в bash),
// сначала возвращает краткое содержимое и просит прочитать файл или править через `edit`.
// Повторный идентичный `write` пропускается — это сознательная полная перезапись.
// Идея fact-gate из ECC (GateGuard, MIT), реализация независимая и мягкая (один возврат, без тупиков).
import fs from 'node:fs';
import path from 'node:path';
import { safeWorkspacePath } from '../security.mjs';

const MAX_SESSIONS = 200;
const MAX_PATHS = 2_000;
const MAX_COMMANDS = 60;
const PREVIEW_LINES = 40;
const PREVIEW_CHARS = 3_000;

const sessions = new Map();

function state(sessionId) {
  let s = sessions.get(sessionId);
  if (!s) {
    s = { seen: new Set(), commands: [], warned: new Map() };
    sessions.set(sessionId, s);
    if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  }
  return s;
}

const normalize = (p) =>
  path.posix.normalize(
    String(p || '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, ''),
  );

export function noteFileSeen(sessionId, relPath) {
  if (!sessionId || !relPath) return;
  const s = state(sessionId);
  s.seen.add(normalize(relPath));
  if (s.seen.size > MAX_PATHS) s.seen.delete(s.seen.values().next().value);
}

export function noteShellCommand(sessionId, command) {
  if (!sessionId || !command) return;
  const s = state(sessionId);
  s.commands.push(String(command).slice(0, 600));
  if (s.commands.length > MAX_COMMANDS) s.commands.shift();
}

export function clearFileAwareness(sessionId) {
  sessions.delete(sessionId);
}

export function resetFileAwarenessForTests() {
  sessions.clear();
}

/** Что агент успел сделать с результатом инструмента: запомнить прочитанное/записанное. */
export function observeFileTool(sessionId, call, result) {
  if (!sessionId || result?.isError) return;
  const name = String(call?.name || '').toLowerCase();
  if (name === 'read') noteFileSeen(sessionId, call?.arguments?.path);
  else if (['write', 'edit', 'apply_patch'].includes(name)) for (const p of result?.mutatedPaths || []) noteFileSeen(sessionId, p);
  else if (name === 'bash') noteShellCommand(sessionId, call?.arguments?.command);
}

/**
 * Возвращает текст-отказ для первого `write` поверх незнакомого файла, иначе null.
 * Любая неожиданность (нет файла, путь вне workspace, ошибка чтения) — null: решает сам инструмент.
 */
export function overwriteGate(sessionId, workspace, call) {
  if (String(call?.name || '').toLowerCase() !== 'write' || !sessionId) return null;
  try {
    const rel = normalize(call?.arguments?.path);
    if (!rel || rel === '.') return null;
    const full = safeWorkspacePath(workspace, rel, { allowMissing: true });
    const st = fs.statSync(full, { throwIfNoEntry: false });
    if (!st?.isFile() || st.size === 0) return null;
    const s = state(sessionId);
    if (s.seen.has(rel) || s.commands.some((c) => c.includes(rel))) return null;
    const content = String(call?.arguments?.content ?? '');
    // Тот же вызов повторён — осознанная перезапись.
    const fingerprint = `${content.length}:${content.slice(0, 64)}`;
    if (s.warned.get(rel) === fingerprint) return null;
    s.warned.set(rel, fingerprint);
    let preview = '';
    if (st.size <= 2_000_000) {
      const text = fs.readFileSync(full, 'utf8');
      if (text.includes('\u0000')) preview = '(binary file)';
      else preview = text.split('\n').slice(0, PREVIEW_LINES).join('\n').slice(0, PREVIEW_CHARS);
    }
    return [
      `Not written: ${rel} already exists (${st.size} bytes) and you have not read it in this chat, so a full rewrite could silently destroy content you have not seen.`,
      'Read it first (read) and change only what is needed with edit. If you really intend to replace the whole file, send the same write call again and it will go through.',
      preview ? `Start of the existing file:\n${preview}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  } catch {
    return null;
  }
}
