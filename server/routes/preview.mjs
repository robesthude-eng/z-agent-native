import fs from 'node:fs';
import path from 'node:path';
import { sendJson } from '../native/json.mjs';
import { openWorkspaceFile, readFd } from '../native/workspace-fs.mjs';
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
    "sandbox allow-scripts allow-forms allow-popups",
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
  catch {
    sendJson(res, 400, { error: 'Bad request' });
    return;
  }
  let full;
  let st;
  let fd;
  try {
    // Дескриптор открывается без перехода по symlink на любом компоненте пути
    // и дальше отдаётся именно он: подмена файла после проверки не выведет
    // превью за пределы workspace.
    ({ fd, full, stat: st } = openWorkspaceFile(workspaceFor(psid), relative));
  } catch (err) {
    if (err?.code === 'ENOENT') sendJson(res, 404, { error: 'Not found' });
    else if (err?.message === 'Path is not a file') sendJson(res, 404, { error: 'Not a file' });
    else sendJson(res, err?.statusCode || 403, { error: err?.message || 'Forbidden' });
    return;
  }

  if (/\.html?$/i.test(full) && st.size > 0 && st.size <= PREVIEW_HTML_REWRITE_LIMIT) {
    let rewritten = null;
    try { rewritten = Buffer.from(rewritePreviewHtml(readFd(fd, st.size).toString('utf8')), 'utf8'); } catch { rewritten = null; }
    if (rewritten) {
      fs.closeSync(fd);
      res.writeHead(200, {
        'content-type': mimeFor(full),
        'content-length': rewritten.length,
        'access-control-allow-origin': '*',
        'content-security-policy': previewSecurityPolicy(req),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
      });
      res.end(rewritten);
      return;
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
  fs.createReadStream(null, { fd, start: 0, autoClose: true }).pipe(res);
}

export function handleTokenPreview(req, res, p) {
  const tokenPreview = /^\/api\/preview\/([a-f0-9]{64})\/~\/(.*)$/.exec(p);
  if (tokenPreview && req.method === 'GET') {
    const grant = resolvePreviewToken(tokenPreview[1]);
    if (!grant || !ownsChat(grant.sessionId, grant.ownerId)) {
      sendJson(res, 404, { error: 'Not found' });
      return true;
    }
    servePreviewFile(req, res, grant.sessionId, tokenPreview[2]);
    return true;
  }
  return false;
}
