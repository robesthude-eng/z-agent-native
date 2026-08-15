import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export function safeWorkspacePath(root, input = '.', { allowMissing = true } = {}) {
  const raw = String(input || '.');
  if (raw.includes('\0')) throw Object.assign(new Error('Некорректный путь'), { statusCode: 400 });
  if (path.isAbsolute(raw)) throw Object.assign(new Error('Разрешены только относительные пути workspace'), { statusCode: 400 });
  const base = path.resolve(root);
  const target = path.resolve(base, raw);
  if (target !== base && !target.startsWith(base + path.sep)) throw Object.assign(new Error('Путь выходит за пределы workspace'), { statusCode: 403 });

  // Не разрешаем проход через symlink: агент не должен выйти из sandbox через
  // заранее подготовленный link в проекте.
  const rel = path.relative(base, target);
  let cur = base;
  for (const segment of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, segment);
    try {
      const st = fs.lstatSync(cur);
      if (st.isSymbolicLink()) throw Object.assign(new Error('Symlink-пути запрещены'), { statusCode: 403 });
    } catch (err) {
      if (err?.code === 'ENOENT' && allowMissing) break;
      throw err;
    }
  }
  return target;
}

function ipv4Private(ip) {
  const [a,b] = ip.split('.').map(Number);
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function ipBlocked(ip) {
  if (net.isIPv4(ip)) return ipv4Private(ip);
  if (!net.isIPv6(ip)) return true;
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? ipv4Private(mapped[1]) : false;
}

export async function assertSafeExternalUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw Object.assign(new Error('Некорректный URL'), { statusCode: 400 }); }
  if (!['http:', 'https:'].includes(url.protocol)) throw Object.assign(new Error('Разрешены только http/https URL'), { statusCode: 400 });
  if (url.username || url.password) throw Object.assign(new Error('Credentials в URL запрещены'), { statusCode: 400 });
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (ipBlocked(host)) throw Object.assign(new Error('Локальные и служебные адреса запрещены'), { statusCode: 403 });
    return url;
  }
  const answers = await dns.lookup(host, { all: true, verbatim: true });
  if (!answers.length || answers.some((a) => ipBlocked(a.address))) throw Object.assign(new Error('URL разрешается в локальную/служебную сеть'), { statusCode: 403 });
  return url;
}
