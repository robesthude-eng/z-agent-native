import fs from 'node:fs';
import path from 'node:path';
import { MAX_INFLIGHT_UPLOAD_BYTES, MAX_UPLOAD_BYTES } from './config.mjs';
import { emit } from './events.mjs';
import { diffGitChange, listGitChanges, revertGitChange } from './git-changes.mjs';
import { sendJson } from './json.mjs';
import { boundaryFromContentType, fileSink, PART_TOO_LARGE, parseMultipartStream } from './multipart.mjs';
import { ensureManagedHome, prepareWorkspaceSandbox, sandboxCommand, syncSandboxOwnership } from './sandbox.mjs';
import { safeWorkspacePath } from './security.mjs';
import { contentVersion, mkdirWorkspaceDir, openWorkspaceFile, readWorkspaceFile, writeWorkspaceFile } from './workspace-fs.mjs';
import { workspaceFor } from './store.mjs';
import { getTurnResult, getTurnResultDiff, rollbackTurnResult } from './turn-results.mjs';
import { collectWorkspaceTree } from './workspace-tree.mjs';

const TEXT_EXTS = new Set([
  '.txt',
  '.md',
  '.json',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.css',
  '.scss',
  '.html',
  '.xml',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.php',
  '.swift',
  '.sh',
  '.bash',
  '.zsh',
  '.sql',
  '.graphql',
  '.vue',
  '.svelte',
  '.astro',
  '.env',
  '.csv',
  '.tsv',
  '.log',
]);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);

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
  return {
    path: path.relative(root, full).split(path.sep).join('/') || '.',
    name: path.basename(full),
    type: st.isDirectory() ? 'directory' : 'file',
    isDirectory: st.isDirectory(),
    size: st.isFile() ? st.size : undefined,
  };
}

function listDir(root, relative) {
  const full = safeWorkspacePath(root, relative || '.', { allowMissing: false });
  return fs
    .readdirSync(full, { withFileTypes: true })
    .filter((entry) => entry.name !== '.agent-home')
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .map((entry) => {
      const target = path.join(full, entry.name);
      return node(root, target, fs.lstatSync(target));
    });
}

function uniqueUploadPath(root, name) {
  const uploads = safeWorkspacePath(root, 'uploads');
  fs.mkdirSync(uploads, { recursive: true });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are deliberately stripped from uploaded file names
  const clean = path.basename(name || 'file').replace(/[\u0000-\u001f]/g, '_');
  const ext = path.extname(clean);
  const stem = path.basename(clean, ext) || 'file';
  let candidate = path.join(uploads, clean);
  for (let i = 2; fs.existsSync(candidate); i++) candidate = path.join(uploads, `${stem}-${i}${ext}`);
  return candidate;
}

function gitOptions(sessionId, root) {
  const identity = prepareWorkspaceSandbox(sessionId, root);
  const home = ensureManagedHome(sessionId, root);
  const launch = sandboxCommand(identity, 'git');
  return {
    executor: identity,
    spawnFile: launch.file,
    spawnArgsPrefix: launch.args,
    spawnOptions: launch.options,
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
  return sendJson(res, status, {
    error: err?.message || fallback,
    ...(Array.isArray(err?.conflicts) ? { conflicts: err.conflicts } : {}),
    ...(typeof err?.code === 'string' && /^[A-Z_]+$/.test(err.code) ? { code: err.code } : {}),
    ...(typeof err?.reason === 'string' ? { reason: err.reason } : {}),
  });
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

// Агентные ссылки на файлы иногда приходят с обёрткой из бэктиков/кавычек
// («📎 x → `src/a.ts`»). В URL она кодируется как %60 и safeWorkspacePath
// отдаёт ENOENT, хотя файл существует. Снимаем обёртку на входе HTTP-роутов,
// чтобы открывались и старые сообщения из истории.
function unwrapWorkspaceQueryPath(value) {
  return String(value || '')
    .trim()
    .replace(/^["'`]+/, '')
    .replace(/["'`]+$/, '');
}

export async function handleWorkspace(req, res, sessionId, url) {
  const root = workspaceFor(sessionId);
  const pathname = url.pathname;

  if (pathname === '/api/workspace/tree' && req.method === 'GET') {
    try {
      return sendJson(res, 200, collectWorkspaceTree(root));
    } catch (err) {
      return workspaceError(res, err, 'Не удалось получить полное дерево файлов');
    }
  }
  if (pathname === '/api/file' && req.method === 'GET')
    return sendJson(res, 200, listDir(root, unwrapWorkspaceQueryPath(url.searchParams.get('path')) || '.'));
  if (pathname === '/api/file/content' && req.method === 'GET') {
    let file;
    try {
      file = readWorkspaceFile(root, unwrapWorkspaceQueryPath(url.searchParams.get('path')), { maxBytes: 4 * 1024 * 1024 });
    } catch (err) {
      if (err?.code === 'FILE_TOO_LARGE') return sendJson(res, 413, { error: 'Файл слишком большой для редактора' });
      throw err;
    }
    const buf = file.buffer;
    if (buf.includes(0)) return sendJson(res, 415, { error: 'Бинарный файл нельзя открыть как текст' });
    // version — хеш содержимого на момент чтения. Редактор присылает его при
    // сохранении, и запись поверх более свежей версии отклоняется с 409.
    return sendJson(res, 200, {
      path: path.relative(root, file.full).split(path.sep).join('/'),
      content: buf.toString('utf8'),
      version: contentVersion(buf),
    });
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
      const relativePath = unwrapWorkspaceQueryPath(url.searchParams.get('path'));
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
    const content = String(body.content ?? '');
    // Без baseVersion запись безусловная (старые клиенты и сценарии). С ним —
    // условная: если файл изменили после открытия (агент, другая вкладка),
    // сохранение старого черновика больше не затирает молча новую работу.
    const baseVersion = typeof body.baseVersion === 'string' && body.baseVersion ? body.baseVersion : null;
    const guard =
      baseVersion && body.force !== true
        ? (previous) => {
            const current = previous == null ? null : contentVersion(previous);
            if (current === baseVersion) return;
            throw Object.assign(
              new Error(previous == null ? 'Файл удалён после открытия в редакторе' : 'Файл изменился после открытия в редакторе'),
              {
                statusCode: 409,
                code: 'WORKSPACE_FILE_CONFLICT',
                currentVersion: current,
                exists: previous != null,
              },
            );
          }
        : null;
    let written;
    try {
      written = writeWorkspaceFile(root, body.path, content, { mkdirs: true, guard });
    } catch (err) {
      if (err?.code === 'WORKSPACE_FILE_CONFLICT') {
        return sendJson(res, 409, { error: err.message, code: err.code, version: err.currentVersion, exists: err.exists });
      }
      return workspaceError(res, err, 'Не удалось сохранить файл');
    }
    syncSandboxOwnership(sessionId, root, written.full);
    emit(sessionId, 'file.edited', { paths: [body.path] });
    return sendJson(res, 200, { ok: true, path: body.path, size: written.bytes, version: contentVersion(content) });
  }
  if (pathname === '/api/workspace/file' && req.method === 'POST') {
    const body = req.bodyJson || {};
    const full = safeWorkspacePath(root, body.path, { allowMissing: true });
    if (fs.existsSync(full)) return sendJson(res, 409, { error: 'Файл уже существует' });
    try {
      if (body.type === 'directory') mkdirWorkspaceDir(root, body.path);
      else fs.closeSync(openWorkspaceFile(root, body.path, { write: true, create: true, exclusive: true, mkdirs: true }).fd);
    } catch (err) {
      if (err?.code === 'EEXIST') return sendJson(res, 409, { error: 'Файл уже существует' });
      return workspaceError(res, err, 'Не удалось создать файл');
    }
    syncSandboxOwnership(sessionId, root, full);
    emit(sessionId, 'file.edited', { paths: [body.path] });
    return sendJson(res, 200, { ok: true, path: body.path, type: body.type === 'directory' ? 'directory' : 'file' });
  }
  if (pathname === '/api/workspace/file' && req.method === 'DELETE') {
    const p = url.searchParams.get('path') || '';
    const full = safeWorkspacePath(root, p, { allowMissing: false });
    // `.` resolves to the session workspace itself. Removing it through the
    // single-file endpoint would also erase every unrelated project file and
    // the runtime-owned .agent-home in one request.
    if (path.resolve(full) === path.resolve(root)) {
      return sendJson(res, 400, { error: 'Корень workspace удалить нельзя' });
    }
    // .agent-home is hidden from the tree, so the UI can never offer it, but the
    // endpoint took any path. Deleting it wipes the sandbox HOME: provisioned
    // toolchains, caches and the git config the runtime writes for the session.
    if (path.resolve(full) === path.resolve(root, '.agent-home')) {
      return sendJson(res, 400, { error: 'Служебный каталог .agent-home удалить нельзя' });
    }
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
    return sendJson(res, 200, {
      ok: true,
      name: path.basename(full),
      path: workspacePath,
      workspacePath,
      agentPath: workspacePath,
      size: file.size,
      kind: kindOf(full),
    });
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
    const p = unwrapWorkspaceQueryPath(url.searchParams.get('path'));
    const full = safeWorkspacePath(root, p, { allowMissing: false });
    const st = fs.statSync(full);
    if (!st.isFile()) return sendJson(res, 400, { error: 'Скачивание каталогов пока не поддерживается' });
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'content-length': st.size,
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(full))}`,
    });
    fs.createReadStream(full).pipe(res);
    return;
  }

  return false;
}
