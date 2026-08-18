import fs from 'node:fs';
import path from 'node:path';
import { MAX_INFLIGHT_UPLOAD_BYTES, MAX_UPLOAD_BYTES } from './config.mjs';
import { emit } from './events.mjs';
import { diffGitChange, listGitChanges, revertGitChange } from './git-changes.mjs';
import { sendJson } from './json.mjs';
import { boundaryFromContentType, fileSink, parseMultipartStream, PART_TOO_LARGE } from './multipart.mjs';
import { safeWorkspacePath } from './security.mjs';
import { sandboxSpawnOptions, syncSandboxOwnership } from './sandbox.mjs';
import { workspaceFor } from './store.mjs';
import { getTurnResult, getTurnResultDiff, rollbackTurnResult } from './turn-results.mjs';

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

export { parseMultipart } from './multipart.mjs';

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
  const clean = path.basename(name || 'file').replace(/[\\u0000-\\u001f]/g, '_');
  const ext = path.extname(clean);
  const stem = path.basename(clean, ext) || 'file';
  let candidate = path.join(uploads, clean);
  for (let i=2; fs.existsSync(candidate); i++) candidate = path.join(uploads, `${stem}-${i}${ext}`);
  return candidate;
}

function gitOptions(sessionId, root) {
  const home = path.join(root, '.agent-home');
  fs.mkdirSync(home, { recursive: true });
  return {
    spawnOptions: sandboxSpawnOptions(sessionId, root),
    env: {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      USER: 'agent',
      LANG: process.env.LANG || 'C.UTF-8',
      TERM: 'dumb',
    },
  };
}

function workspaceError(res, err, fallback) {
  const status = Number(err?.statusCode) || 400;
  return sendJson(res, status, { error: err?.message || fallback, ...(Array.isArray(err?.conflicts) ? { conflicts: err.conflicts } : {}) });
}

function publicTurnResult(result) {
  return {
    version: result.version,
    sessionId: result.sessionId,
    messageId: result.messageId,
    turnId: result.turnId,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    reason: result.reason,
    changeCount: result.changeCount,
    rolledBackAt: result.rolledBackAt || null,
    changes: result.changes || [],
  };
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
      return sendJson(res, 200, listGitChanges(root, gitOptions(sessionId, root)));
    } catch {
      return sendJson(res, 200, []);
    }
  }
  if (pathname === '/api/file/diff' && req.method === 'GET') {
    try {
      const relativePath = url.searchParams.get('path') || '';
      return sendJson(res, 200, diffGitChange(root, relativePath, gitOptions(sessionId, root)));
    } catch (err) {
      return workspaceError(res, err, 'Не удалось построить diff');
    }
  }
  if (pathname === '/api/file/revert' && req.method === 'POST') {
    try {
      const relativePath = String(req.bodyJson?.path || '');
      const result = revertGitChange(root, relativePath, gitOptions(sessionId, root));
      syncSandboxOwnership(sessionId, root, root);
      const paths = [result.path, result.originalPath].filter(Boolean);
      emit(sessionId, 'file.edited', { paths });
      return sendJson(res, 200, result);
    } catch (err) {
      return workspaceError(res, err, 'Не удалось откатить изменение');
    }
  }

  if (pathname === '/api/workspace/turn-result' && req.method === 'GET') {
    try {
      const messageId = url.searchParams.get('messageId') || '';
      return sendJson(res, 200, publicTurnResult(getTurnResult(sessionId, messageId)));
    } catch (err) {
      return workspaceError(res, err, 'Не удалось получить результат хода');
    }
  }
  if (pathname === '/api/workspace/turn-result/diff' && req.method === 'GET') {
    try {
      const messageId = url.searchParams.get('messageId') || '';
      const relativePath = url.searchParams.get('path') || '';
      return sendJson(res, 200, getTurnResultDiff(sessionId, messageId, relativePath));
    } catch (err) {
      return workspaceError(res, err, 'Не удалось построить diff этого хода');
    }
  }
  if (pathname === '/api/workspace/turn-result/rollback' && req.method === 'POST') {
    try {
      const messageId = String(req.bodyJson?.messageId || '');
      const result = rollbackTurnResult(sessionId, messageId);
      emit(sessionId, 'file.edited', { paths: result.restored?.length ? result.restored : ['.'] });
      return sendJson(res, 200, result);
    } catch (err) {
      return workspaceError(res, err, 'Не удалось откатить работу этого хода');
    }
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
    const boundary = boundaryFromContentType(req.headers['content-type']);
    if (!boundary) return sendJson(res, 400, { error: 'multipart boundary missing' });
    // Stream the part straight to disk. Buffering the request first meant a
    // single large upload pinned at least twice its size in the heap before
    // anything was written, so a few parallel uploads could kill the process.
    let target = null;
    const parsed = await parseMultipartStream(req, boundary, {
      maxPartBytes: MAX_UPLOAD_BYTES,
      maxTotalBytes: MAX_UPLOAD_BYTES + 1024 * 1024,
      maxParts: 32,
      openPart: ({ filename }) => {
        if (!filename || target) return null;
        target = fileSink(uniqueUploadPath(root, filename));
        return target;
      },
    });
    const file = parsed.parts.find((part) => part.filename);
    if (!file) return sendJson(res, 400, { error: 'file missing' });
    if (file.error === PART_TOO_LARGE) return sendJson(res, 413, { error: 'Файл слишком большой' });
    if (file.error || !target) return sendJson(res, 400, { error: file.error || 'file missing' });
    const full = target.path;
    syncSandboxOwnership(sessionId, root, full);
    const workspacePath = path.relative(root, full).split(path.sep).join('/');
    emit(sessionId, 'file.edited', { paths: [workspacePath] });
    return sendJson(res, 200, { ok: true, name: path.basename(full), path: workspacePath, workspacePath, agentPath: workspacePath, size: file.size, kind: kindOf(full) });
  }

  if (pathname === '/api/workspace/upload-folder' && req.method === 'POST') {
    const boundary = boundaryFromContentType(req.headers['content-type']);
    if (!boundary) return sendJson(res, 400, { error: 'multipart boundary missing' });
    // Folder uploads arrive as hundreds of parts. Each one is written while it
    // streams in, an unsafe path only fails its own part, and the request as a
    // whole stays bounded.
    const parsed = await parseMultipartStream(req, boundary, {
      maxPartBytes: MAX_UPLOAD_BYTES,
      maxTotalBytes: MAX_INFLIGHT_UPLOAD_BYTES,
      maxParts: 4096,
      openPart: ({ name }) => {
        if (!name) return { skip: 'part name missing' };
        return fileSink(safeWorkspacePath(root, name, { allowMissing: true }), { overwrite: true });
      },
    });
    const errors = parsed.parts.filter((part) => part.error).map((part) => `${part.name}: ${part.error}`);
    const written = parsed.parts.filter((part) => !part.error && !part.skipped).length;
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
