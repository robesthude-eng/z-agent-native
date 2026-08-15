import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_UPLOAD_BYTES } from './config.mjs';
import { emit } from './events.mjs';
import { readBody, sendJson } from './json.mjs';
import { safeWorkspacePath } from './security.mjs';
import { sandboxSpawnOptions, syncSandboxOwnership } from './sandbox.mjs';
import { workspaceFor } from './store.mjs';

const TEXT_EXTS = new Set(['.txt','.md','.json','.js','.jsx','.ts','.tsx','.css','.scss','.html','.xml','.yaml','.yml','.toml','.ini','.cfg','.conf','.py','.rb','.go','.rs','.java','.kt','.c','.cpp','.h','.hpp','.cs','.php','.swift','.sh','.bash','.zsh','.sql','.graphql','.vue','.svelte','.astro','.env','.csv','.tsv','.log']);
const IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.gif','.webp','.bmp','.svg']);

function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.zip') return 'zip';
  if (TEXT_EXTS.has(ext)) return 'text';
  return 'binary';
}

export function parseMultipart(buffer, boundary) {
  const out = [];
  const marker = Buffer.from(`--${boundary}`);
  let pos = 0;
  while (true) {
    const start = buffer.indexOf(marker, pos);
    if (start < 0) break;
    let cursor = start + marker.length;
    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) break;
    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) cursor += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), cursor);
    if (headerEnd < 0) break;
    const headers = buffer.slice(cursor, headerEnd).toString('utf8');
    const next = buffer.indexOf(marker, headerEnd + 4);
    const end = next < 0 ? buffer.length : next - 2;
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    const filename = /filename="([^"]*)"/.exec(headers)?.[1] || null;
    if (name) out.push({ name, filename, data: buffer.slice(headerEnd + 4, end) });
    if (next < 0) break;
    pos = next;
  }
  return out;
}

function node(root, full, st) {
  return { path: path.relative(root, full).split(path.sep).join('/') || '.', name: path.basename(full), type: st.isDirectory() ? 'directory' : 'file', isDirectory: st.isDirectory(), size: st.isFile() ? st.size : undefined };
}

function listDir(root, relative) {
  const full = safeWorkspacePath(root, relative || '.', { allowMissing: false });
  return fs.readdirSync(full, { withFileTypes: true }).sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).map((entry) => {
    const target = path.join(full, entry.name);
    return node(root, target, fs.statSync(target));
  });
}

function tree(root) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === '.agent-home') continue;
      const full = path.join(dir, entry.name);
      const item = node(root, full, fs.statSync(full));
      out.push(item);
      if (entry.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

function uniqueUploadPath(root, name) {
  const uploads = safeWorkspacePath(root, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  const clean = path.basename(name || 'file').replace(/[\u0000-\u001f]/g, '_');
  const ext = path.extname(clean);
  const stem = path.basename(clean, ext) || 'file';
  let candidate = path.join(uploads, clean);
  for (let i=2; fs.existsSync(candidate); i++) candidate = path.join(uploads, `${stem}-${i}${ext}`);
  return candidate;
}

export async function handleWorkspace(req, res, sessionId, url) {
  const root = workspaceFor(sessionId);
  const pathname = url.pathname;

  if (pathname === '/api/workspace/tree' && req.method === 'GET') return sendJson(res, 200, tree(root));
  if (pathname === '/api/file' && req.method === 'GET') return sendJson(res, 200, listDir(root, url.searchParams.get('path') || '.'));
  if (pathname === '/api/file/content' && req.method === 'GET') {
    const full = safeWorkspacePath(root, url.searchParams.get('path') || '', { allowMissing: false });
    const buf = fs.readFileSync(full);
    if (buf.length > 4 * 1024 * 1024) return sendJson(res, 413, { error: 'Файл слишком большой для редактора' });
    if (buf.includes(0)) return sendJson(res, 415, { error: 'Бинарный файл нельзя открыть как текст' });
    return sendJson(res, 200, { path: path.relative(root, full).split(path.sep).join('/'), content: buf.toString('utf8') });
  }
  if (pathname === '/api/file/status' && req.method === 'GET') {
    try {
      const home = path.join(root, '.agent-home');
      fs.mkdirSync(home, { recursive: true });
      const identity = sandboxSpawnOptions(sessionId, root);
      const text = execFileSync('git', ['status', '--porcelain=v1'], {
        cwd: root, encoding: 'utf8', timeout: 5000, ...identity,
        env: {
          PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
          HOME: home, USER: 'agent', LANG: process.env.LANG || 'C.UTF-8', TERM: 'dumb',
        },
      });
      const rows = text.split('\n').filter(Boolean).map((line) => {
        const code = line.slice(0,2); const p = line.slice(3).trim().replace(/^.* -> /, '');
        let status = 'modified';
        if (code.includes('?')) status = 'untracked'; else if (code.includes('A')) status='added'; else if (code.includes('D')) status='deleted'; else if (code.includes('R')) status='renamed';
        return { path: p, status };
      });
      return sendJson(res, 200, rows);
    } catch { return sendJson(res, 200, []); }
  }

  if (pathname === '/api/workspace/file' && req.method === 'PUT') {
    const body = req.bodyJson || {};
    const full = safeWorkspacePath(root, body.path, { allowMissing: true });
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, String(body.content ?? ''), 'utf8');
    syncSandboxOwnership(sessionId, root, full);
    emit(sessionId, 'file.edited', { paths: [body.path] });
    return sendJson(res, 200, { ok: true, path: body.path, size: Buffer.byteLength(String(body.content ?? '')) });
  }
  if (pathname === '/api/workspace/file' && req.method === 'POST') {
    const body = req.bodyJson || {};
    const full = safeWorkspacePath(root, body.path, { allowMissing: true });
    if (fs.existsSync(full)) return sendJson(res, 409, { error: 'Файл уже существует' });
    if (body.type === 'directory') fs.mkdirSync(full, { recursive: true });
    else { fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, '', 'utf8'); }
    syncSandboxOwnership(sessionId, root, full);
    emit(sessionId, 'file.edited', { paths: [body.path] });
    return sendJson(res, 200, { ok: true, path: body.path, type: body.type === 'directory' ? 'directory' : 'file' });
  }
  if (pathname === '/api/workspace/file' && req.method === 'DELETE') {
    const p = url.searchParams.get('path') || '';
    const full = safeWorkspacePath(root, p, { allowMissing: false });
    fs.rmSync(full, { recursive: true, force: true });
    emit(sessionId, 'file.edited', { paths: [p] });
    return sendJson(res, 200, { ok: true, path: p });
  }
  if (pathname === '/api/workspace/file/rename' && req.method === 'POST') {
    const body = req.bodyJson || {};
    const from = safeWorkspacePath(root, body.from, { allowMissing: false });
    const to = safeWorkspacePath(root, body.to, { allowMissing: true });
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    syncSandboxOwnership(sessionId, root, to);
    emit(sessionId, 'file.edited', { paths: [body.from, body.to] });
    return sendJson(res, 200, { ok: true, from: body.from, to: body.to });
  }

  if (pathname === '/api/workspace/upload' && req.method === 'POST') {
    const ct = String(req.headers['content-type'] || '');
    const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct)?.[1] || /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct)?.[2];
    if (!boundary) return sendJson(res, 400, { error: 'multipart boundary missing' });
    const buf = await readBody(req, MAX_UPLOAD_BYTES + 1024 * 1024);
    const file = parseMultipart(buf, boundary).find((p) => p.filename);
    if (!file) return sendJson(res, 400, { error: 'file missing' });
    if (file.data.length > MAX_UPLOAD_BYTES) return sendJson(res, 413, { error: 'Файл слишком большой' });
    const full = uniqueUploadPath(root, file.filename);
    fs.writeFileSync(full, file.data, { flag: 'wx' });
    syncSandboxOwnership(sessionId, root, full);
    const workspacePath = path.relative(root, full).split(path.sep).join('/');
    emit(sessionId, 'file.edited', { paths: [workspacePath] });
    return sendJson(res, 200, { ok: true, name: path.basename(full), path: workspacePath, workspacePath, agentPath: workspacePath, size: file.data.length, kind: kindOf(full) });
  }

  if (pathname === '/api/workspace/upload-folder' && req.method === 'POST') {
    const ct = String(req.headers['content-type'] || '');
    const match = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
    const boundary = match?.[1] || match?.[2];
    if (!boundary) return sendJson(res, 400, { error: 'multipart boundary missing' });
    const buf = await readBody(req, MAX_UPLOAD_BYTES + 1024 * 1024);
    const parts = parseMultipart(buf, boundary);
    let written = 0;
    const errors = [];
    for (const part of parts) {
      try {
        if (part.data.length > MAX_UPLOAD_BYTES) throw new Error('file too large');
        const full = safeWorkspacePath(root, part.name, { allowMissing: true });
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, part.data);
        written++;
      } catch (err) { errors.push(`${part.name}: ${err.message}`); }
    }
    syncSandboxOwnership(sessionId, root, root);
    emit(sessionId, 'file.edited', { paths: ['.'] });
    return sendJson(res, 200, { ok: errors.length === 0, written, ...(errors.length ? { errors } : {}) });
  }

  if (pathname === '/api/workspace/download' && req.method === 'GET') {
    const p = url.searchParams.get('path') || '';
    const full = safeWorkspacePath(root, p, { allowMissing: false });
    const st = fs.statSync(full);
    if (!st.isFile()) return sendJson(res, 400, { error: 'Скачивание каталогов пока не поддерживается' });
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': st.size, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(full))}` });
    fs.createReadStream(full).pipe(res);
    return;
  }

  return false;
}
