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

const PREVIEW_HTML_REWRITE_LIMIT = 2 * 1024 * 1024;

export function servePreviewFile(req, res, psid, rawRelative) {
  let relative;
  try { relative = rawRelative.split('/').map(decodeURIComponent).join('/'); }
  catch { return sendJson(res, 400, { error: 'Bad request' }); }
  const full = safeWorkspacePath(workspaceFor(psid), relative, { allowMissing: false });
  const st = fs.statSync(full);
  if (!st.isFile()) return sendJson(res, 404, { error: 'Not a file' });

  if (/\.html?$/i.test(full) && st.size > 0 && st.size <= PREVIEW_HTML_REWRITE_LIMIT) {
    let rewritten = null;
    try {
      const raw = fs.readFileSync(full, 'utf8');
      rewritten = rewritePreviewHtml(raw);
    } catch {
      rewritten = null;
    }
    if (typeof rewritten === 'string') {
      const body = Buffer.from(rewritten, 'utf8');
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': String(body.length),
        'cache-control': 'no-store, no-cache, must-revalidate',
        'access-control-allow-origin': '*',
        'content-security-policy': "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: *; img-src * data: blob:; media-src * data: blob:; connect-src * data: blob:; font-src * data:; frame-src *; object-src 'none'",
      });
      return res.end(body);
    }
  }

  const ext = path.extname(full).toLowerCase();
  const ctype = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': ctype,
    'content-length': String(st.size),
    'cache-control': 'no-store, no-cache, must-revalidate',
    'access-control-allow-origin': '*',
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
