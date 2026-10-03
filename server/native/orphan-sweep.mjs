import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, WORKSPACES_DIR } from './config.mjs';
import { db } from './store/db.mjs';

const SESSION_ENTRY = /^(ses_[A-Za-z0-9]+)(\.json)?$/;

/**
 * Удалить данные чатов, которых больше нет в базе.
 *
 * Обычное удаление чата стирает всё сразу, но удаление, прерванное
 * перезапуском, или чаты, удалённые старыми версиями, оставляли на диске
 * папки проектов, память проекта, durable-задачи и результаты ходов.
 * Запускается при старте сервера; трогает только имена вида ses_*.
 */
export function sweepOrphanSessionData({ dataDir = DATA_DIR, workspacesDir = WORKSPACES_DIR, database = db } = {}) {
  const alive = new Set(database.prepare('SELECT id FROM chats').all().map((row) => row.id));
  const targets = [
    workspacesDir,
    path.join(dataDir, 'durable-jobs'),
    path.join(dataDir, 'project-context'),
    path.join(dataDir, 'turn-results'),
  ];
  let removed = 0;
  for (const dir of targets) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      const match = SESSION_ENTRY.exec(name);
      if (!match || alive.has(match[1])) continue;
      try {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        removed += 1;
      } catch { /* best effort */ }
    }
  }
  return removed;
}
