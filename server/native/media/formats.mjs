import fs from 'node:fs';
import path from 'node:path';
import { syncSandboxOwnership } from '../sandbox.mjs';
import { safeWorkspacePath } from '../security.mjs';

export const IMAGE_FORMATS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff', 'avif'];
export const VIDEO_FORMATS = ['mp4', 'webm', 'mkv', 'mov', 'gif'];
export const AUDIO_FORMATS = ['mp3', 'wav', 'ogg', 'opus', 'm4a', 'flac', 'aac'];
export const DOCUMENT_FORMATS = ['pdf', 'html', 'png', 'jpg', 'txt', 'md'];

export const MEDIA_TYPES = {
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  webp: { kind: 'image', mime: 'image/webp' },
  gif: { kind: 'image', mime: 'image/gif' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  tiff: { kind: 'image', mime: 'image/tiff' },
  avif: { kind: 'image', mime: 'image/avif' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  mkv: { kind: 'video', mime: 'video/x-matroska' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  opus: { kind: 'audio', mime: 'audio/ogg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  pdf: { kind: 'document', mime: 'application/pdf' },
  html: { kind: 'document', mime: 'text/html; charset=utf-8' },
  md: { kind: 'document', mime: 'text/markdown; charset=utf-8' },
  txt: { kind: 'document', mime: 'text/plain; charset=utf-8' },
};

export function mediaExtension(value) {
  return path.extname(String(value || '')).replace(/^\./, '').toLowerCase();
}

export function mediaKindForPath(value) {
  return MEDIA_TYPES[mediaExtension(value)]?.kind || null;
}

export function mediaMimeType(value) {
  return MEDIA_TYPES[mediaExtension(value)]?.mime || 'application/octet-stream';
}

export function shellQuote(value) {
  const text = String(value);
  if (!text) return "''";
  if (/^[A-Za-z0-9@%_+=:,./-]+$/.test(text)) return text;
  return `'${text.split("'").join(`'\\''`)}'`;
}

export function shellCommand(argv) {
  return argv.map(shellQuote).join(' ');
}

export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function resolveMediaOutput(root, value, allowed, label = 'output') {
  const rel = String(value || '').trim();
  if (!rel) throw Object.assign(new Error(`${label} path is required`), { statusCode: 400 });
  const ext = mediaExtension(rel);
  if (!allowed.includes(ext)) {
    throw Object.assign(new Error(`Unsupported ${label} extension "${ext}". Allowed: ${allowed.join(', ')}`), { statusCode: 400 });
  }
  const abs = safeWorkspacePath(root, rel);
  return { rel, abs, ext };
}

export function resolveMediaInput(root, value, label = 'source') {
  const rel = String(value || '').trim();
  if (!rel) throw Object.assign(new Error(`${label} path is required`), { statusCode: 400 });
  const abs = safeWorkspacePath(root, rel);
  if (!fs.existsSync(abs)) throw Object.assign(new Error(`${label} file "${rel}" not found`), { statusCode: 404 });
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw Object.assign(new Error(`${label} "${rel}" is not a regular file`), { statusCode: 400 });
  return { rel, abs, ext: mediaExtension(rel), size: stat.size };
}

export function writeMediaFile(root, target, bytes, ctx = null) {
  const abs = safeWorkspacePath(root, target);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  if (ctx?.sessionId) {
    try { syncSandboxOwnership(ctx.sessionId, root, abs); } catch {}
  }
  return { abs, size: bytes.length };
}
