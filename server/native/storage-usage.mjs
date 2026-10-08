// Место, занятое рабочими папками чатов: для раздела «Данные» в настройках.
// du быстрее обхода из Node на сотнях тысяч файлов; результат кешируется,
// чтобы повторное открытие настроек не гоняло диск.
import { execFile } from 'node:child_process';
import { listChats, workspaceFor } from './store.mjs';

const TTL_MS = 60_000;
const cache = new Map(); // ownerId -> { at, value }

function du(paths) {
  return new Promise((resolve) => {
    if (!paths.length) return resolve(new Map());
    execFile('du', ['-sb', '--', ...paths], { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => {
      // du печатает строки и при частичных ошибках (файл исчез во время обхода).
      const out = new Map();
      for (const line of String(stdout || '').split('\n')) {
        const m = /^(\d+)\t(.+)$/.exec(line);
        if (m) out.set(m[2], Number(m[1]));
      }
      resolve(out);
    });
  });
}

export async function storageUsage(ownerId, { fresh = false } = {}) {
  const hit = cache.get(ownerId);
  if (!fresh && hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const chats = listChats(ownerId);
  const dirs = chats.map((c) => workspaceFor(c.id));
  const sizes = await du(dirs);
  const items = chats
    .map((c, i) => ({
      id: c.id,
      title: c.title,
      updated: c.time?.updated || 0,
      bytes: sizes.get(dirs[i]) ?? 0,
    }))
    .sort((a, b) => b.bytes - a.bytes);
  const value = { total: items.reduce((s, x) => s + x.bytes, 0), chats: items, measuredAt: Date.now() };
  cache.set(ownerId, { at: Date.now(), value });
  return value;
}

export function invalidateStorageUsage(ownerId) {
  cache.delete(ownerId);
}
