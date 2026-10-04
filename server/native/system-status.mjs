// Состояние сервера для раздела «Сервер» в настройках. Диск, память и
// нагрузку контейнер видит сам (/proc и statfs показывают хост). Контейнеры
// и бэкап снаружи не видны — их раз в минуту пишет на хосте
// z-agent-host-status в /data/host-status.json (см. deploy/host/).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_DIR, WORKSPACES_DIR } from './config.mjs';

const HOST_STATUS_FILE = path.join(DATA_DIR, 'host-status.json');
const HOST_STALE_MS = 5 * 60_000;

function disk(dir) {
  try {
    const st = fs.statfsSync(dir);
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    return { total, free, used: total - st.bfree * st.bsize };
  } catch {
    return null;
  }
}

export function parseMeminfo(text) {
  const kb = (key) => {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text);
    return m ? Number(m[1]) * 1024 : 0;
  };
  const total = kb('MemTotal');
  const available = kb('MemAvailable');
  const swapTotal = kb('SwapTotal');
  return { total, available, used: Math.max(0, total - available), swapTotal, swapUsed: Math.max(0, swapTotal - kb('SwapFree')) };
}

function memory() {
  try { return parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf8')); }
  catch { return { total: os.totalmem(), available: os.freemem(), used: os.totalmem() - os.freemem(), swapTotal: 0, swapUsed: 0 }; }
}

export function readHostStatus(file = HOST_STATUS_FILE, now = Date.now()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const at = Number(raw.generatedAt) || 0;
    return { ...raw, stale: !at || now - at > HOST_STALE_MS };
  } catch {
    return null;
  }
}

export function systemStatus({ activeTurns = 0 } = {}) {
  const dataDisk = disk(DATA_DIR);
  const wsDisk = disk(WORKSPACES_DIR);
  return {
    at: Date.now(),
    host: {
      hostname: os.hostname(),
      cpus: os.cpus().length,
      load: os.loadavg(),
      uptime: os.uptime(),
    },
    memory: memory(),
    disk: dataDisk || wsDisk,
    app: {
      uptime: Math.floor(process.uptime()),
      rss: process.memoryUsage().rss,
      node: process.version,
      activeTurns,
    },
    hostAgent: readHostStatus(),
  };
}
