import fs from 'node:fs';
import path from 'node:path';
import { sendJson } from '../native/json.mjs';
import { safeWorkspacePath } from '../native/security.mjs';
import { workspaceFor, ownsChat } from '../native/store.mjs';
import { mintPreviewToken, resolvePreviewToken } from '../native/preview-tokens.mjs';
import { rewritePreviewHtml } from '../native/preview-document.mjs';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

const PREVIEW_HTML_REWRITE_LIMIT = 2 * 1024 * 1024;

export function previewSecurityPolicy(req) {
  const rawHost = String(req?.headers?.host || '').trim();
  const host = /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(rawHost) ? rawHost : '';
  const forwarded = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const scheme = forwarded === 'https' || forwarded === 'http'
    ? forwarded
    : (req?.socket?.encrypted ? 'https' : 'http');
  const own = host ? `${scheme}://${host}` : '';
  const from = own ? `${own} ` : '';
  return [
    "default-src 'none'",
    `script-src ${from}'unsafe-inline' 'unsafe-eval'`,
    `style-src ${from}'unsafe-inline'`,
    `img-src ${from}data: blob:`,
    `font-src ${from}data:`,
    `media-src ${from}data: blob:`,
    `connect-src ${from}data: blob:`,
    `worker-src ${from}blob:`,
    `frame-src ${from}data: blob:`,
    "frame-ancestors 'self'",
    "base-uri 'none'",
    `form-action ${own || "'none'"}`,
  ].join('; ');
}

export function servePreviewFile(req, res, psid, rawRelative) {
  let relative;
  try { relative = rawRelative.split('/').map(decodeURIComponent).join('/'); }
  catch { return sendJson(res, 400, { error: 'Bad request' }); }
  const full = safeWorkspacePath(workspaceFor(psid), relative, { allowMissing: false });
  const st = fs.statSync(full);
  if (!st.isFile()) return sendJson(res, 404, { error: 'Not a file' });

  if (/\.html?$/i.test(full) && st.size > 0 && st.size <= PREVIEW_HTML_REWRITE_LIMIT) {
    let rewritten = null;
    try { rewritten = Buffer.from(rewritePreviewHtml(fs.readFileSync(full, 'utf8')), 'utf8'); } catch { rewritten = null; }
    if (rewritten) {
      res.writeHead(200, {
        'content-type': mimeFor(full),
        'content-length': rewritten.length,
        'access-control-allow-origin': '*',
        'content-security-policy': previewSecurityPolicy(req),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      });
      return res.end(rewritten);
    }
  }

  res.writeHead(200, {
    'content-type': mimeFor(full),
    'content-length': st.size,
    'access-control-allow-origin': '*',
    'content-security-policy': previewSecurityPolicy(req),
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  return fs.createReadStream(full).pipe(res);
}

export function handleTokenPreview(req, res, p) {
  const tokenPreview = /^\/api\/preview\/([a-f0-9]{64})\/~\/(.*)$/.exec(p);
  if (tokenPreview && req.method === 'GET') {
    const grant = resolvePreviewToken(tokenPreview[1]);
    if (!grant || !ownsChat(grant.sessionId, grant.ownerId)) return sendJson(res, 404, { error: 'Not found' });
    servePreviewFile(req, res, grant.sessionId, tokenPreview[2]);
    return true;
  }
  return false;
}
