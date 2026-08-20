import fs from 'node:fs';
import path from 'node:path';
import { safeWorkspacePath } from './security.mjs';

const MAX_DOCUMENT_BYTES = 400 * 1024;
const MAX_ASSET_BYTES = 256 * 1024;
const MAX_INLINED_BYTES = 1_500_000;

const MIME = {
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  json: 'application/json',
  woff: 'font/woff',
  woff2: 'font/woff2',
  html: 'text/html',
  htm: 'text/html',
};

export function isPublicHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function mimeFor(rel) {
  const ext = path.posix.extname(String(rel || '')).slice(1).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function inlineLocalAssets(root, htmlPath, html) {
  const dir = path.posix.dirname(htmlPath.replace(/\\/g, '/'));
  return String(html || '').replace(
    /(<(?:script|img|source|link|use)\b[^>]*?\s(?:src|href)\s*=\s*)(['"])([^'"]+)\2/gi,
    (all, prefix, quote, spec) => {
      const ref = String(spec || '').trim();
      if (!ref || /^(?:https?:|data:|javascript:|mailto:|#|\/\/)/i.test(ref)) return all;
      const joined = dir === '.' ? ref : path.posix.join(dir, ref);
      const rel = path.posix.normalize(joined.replace(/\\/g, '/'));
      if (!rel || rel === '.' || rel.startsWith('../') || path.posix.isAbsolute(rel)) return all;
      try {
        const full = safeWorkspacePath(root, rel, { allowMissing: false });
        const buf = fs.readFileSync(full);
        if (buf.length > MAX_ASSET_BYTES) return all;
        return `${prefix}${quote}data:${mimeFor(rel)};base64,${buf.toString('base64')}${quote}`;
      } catch {
        return all;
      }
    },
  );
}

/**
 * Load a workspace HTML (or text) document for Chromium setContent.
 * Returns null when `rawUrl` is a public http(s) URL that must follow network policy.
 */
export function readWorkspaceBrowserDocument(root, rawUrl) {
  const requested = String(rawUrl || '').trim();
  if (!requested) throw Object.assign(new Error('open requires url'), { statusCode: 400 });
  if (isPublicHttpUrl(requested)) return null;

  let full;
  try {
    full = safeWorkspacePath(root, requested, { allowMissing: false });
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw Object.assign(new Error(`Workspace file not found: ${requested}`), { statusCode: 404, code: 'BROWSER_LOCAL_MISSING' });
    }
    throw err;
  }

  const rel = path.relative(path.resolve(root), full).split(path.sep).join('/');
  const buf = fs.readFileSync(full);
  if (buf.includes(0)) throw Object.assign(new Error('Binary files cannot be opened in the workspace browser'), { statusCode: 400 });
  if (buf.length > MAX_DOCUMENT_BYTES) {
    throw Object.assign(new Error(`Workspace document is too large for in-browser preview (${buf.length} bytes)`), { statusCode: 400 });
  }

  const ext = path.posix.extname(rel).slice(1).toLowerCase();
  let html = buf.toString('utf8');
  if (['html', 'htm', 'xhtml', 'svg'].includes(ext)) html = inlineLocalAssets(root, rel, html);
  else html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(rel)}</title><pre>${escapeHtml(html)}</pre>`;

  if (Buffer.byteLength(html) > MAX_INLINED_BYTES) {
    throw Object.assign(new Error('Inlined workspace document is too large for in-browser preview'), { statusCode: 400 });
  }
  return { html, href: `workspace://${rel}`, path: rel };
}
