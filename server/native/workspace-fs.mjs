import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeWorkspacePath } from './security.mjs';

// Файлы workspace открывает привилегированный API-процесс, а сам workspace
// одновременно меняют shell агента и пользователь. Проверка пути строкой и
// lstat, а затем отдельное открытие по той же строке оставляли окно: между
// ними файл или каталог можно было подменить symlink-ом и прочитать или
// перезаписать файл за пределами workspace. Здесь каждый компонент пути
// открывается относительно уже открытого дескриптора родителя и без перехода
// по symlink (аналог openat(2) с O_NOFOLLOW), а чтение и запись идут через
// полученный дескриптор, а не по пути.

const C = fs.constants;
const PROC_FD = '/proc/self/fd';
let procFdState = null;

function procFdUsable() {
  if (procFdState !== null) return procFdState;
  procFdState = false;
  let fd = null;
  try {
    fd = fs.openSync('/', C.O_RDONLY | C.O_DIRECTORY);
    procFdState = fs.statSync(`${PROC_FD}/${fd}/.`).isDirectory();
  } catch {
    procFdState = false;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
  return procFdState;
}

function symlinkError() {
  return Object.assign(new Error('Symlink-пути запрещены'), { statusCode: 403 });
}

function notFileError() {
  return Object.assign(new Error('Path is not a file'), { statusCode: 400 });
}

function isSymlink(target) {
  try { return fs.lstatSync(target).isSymbolicLink(); } catch { return false; }
}

function openChildDir(parentFd, name, create) {
  const target = `${PROC_FD}/${parentFd}/${name}`;
  try {
    return fs.openSync(target, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  } catch (err) {
    if (err?.code === 'ENOENT' && create) {
      try { fs.mkdirSync(target); } catch (mkdirErr) { if (mkdirErr?.code !== 'EEXIST') throw mkdirErr; }
      return openChildDir(parentFd, name, false);
    }
    if ((err?.code === 'ENOTDIR' || err?.code === 'ELOOP') && isSymlink(target)) throw symlinkError();
    throw err;
  }
}

function openFinal(target, flags) {
  try {
    return fs.openSync(target, flags, 0o666);
  } catch (err) {
    if (err?.code === 'ELOOP') throw symlinkError();
    throw err;
  }
}

function resolveInside(root, input, allowMissing) {
  const full = safeWorkspacePath(root, input, { allowMissing });
  const base = path.resolve(root);
  const rel = path.relative(base, full);
  return { full, base, rel, segments: rel ? rel.split(path.sep).filter(Boolean) : [] };
}

function walkParents(base, segments, create) {
  // The session root itself is server-owned configuration, not agent input;
  // like the previous recursive mkdir, a first write may create it.
  if (create) fs.mkdirSync(base, { recursive: true });
  let dirFd = fs.openSync(base, C.O_RDONLY | C.O_DIRECTORY);
  try {
    for (const segment of segments) {
      const next = openChildDir(dirFd, segment, create);
      fs.closeSync(dirFd);
      dirFd = next;
    }
    return dirFd;
  } catch (err) {
    try { fs.closeSync(dirFd); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * Open a regular file inside the workspace through a descriptor chain.
 * Returns `{ fd, full, rel, stat }`; the caller owns and must close `fd`.
 */
export function openWorkspaceFile(root, input, { write = false, create = false, exclusive = false, mkdirs = false } = {}) {
  const { full, base, rel, segments } = resolveInside(root, input, create);
  if (!segments.length) throw notFileError();
  const name = segments[segments.length - 1];
  // O_NONBLOCK: подложенный FIFO не должен навсегда занять поток API на open().
  let flags = (write ? C.O_RDWR : C.O_RDONLY) | C.O_NOFOLLOW | C.O_NONBLOCK;
  if (create) flags |= C.O_CREAT;
  if (exclusive) flags |= C.O_EXCL;

  let fd;
  if (procFdUsable()) {
    const dirFd = walkParents(base, segments.slice(0, -1), mkdirs);
    try {
      fd = openFinal(`${PROC_FD}/${dirFd}/${name}`, flags);
    } finally {
      fs.closeSync(dirFd);
    }
  } else {
    // Без /proc (например, macOS при разработке): O_NOFOLLOW на последнем
    // компоненте и сверка открытого inode с повторно проверенным путём.
    if (mkdirs) fs.mkdirSync(path.dirname(full), { recursive: true });
    fd = openFinal(full, flags);
    try {
      const opened = fs.fstatSync(fd);
      safeWorkspacePath(root, rel, { allowMissing: false });
      const current = fs.lstatSync(full);
      if (opened.dev !== current.dev || opened.ino !== current.ino) throw symlinkError();
    } catch (err) {
      fs.closeSync(fd);
      throw err;
    }
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw notFileError();
    return { fd, full, rel: rel.split(path.sep).join('/'), stat };
  } catch (err) {
    fs.closeSync(fd);
    throw err;
  }
}

/** Create a directory (and missing parents) inside the workspace without following symlinks. */
export function mkdirWorkspaceDir(root, input) {
  const { full, base, segments } = resolveInside(root, input, true);
  if (!segments.length) return full;
  if (!procFdUsable()) {
    fs.mkdirSync(full, { recursive: true });
    safeWorkspacePath(root, path.relative(base, full), { allowMissing: false });
    return full;
  }
  fs.closeSync(walkParents(base, segments, true));
  return full;
}

export function readFd(fd, size) {
  const buffer = Buffer.allocUnsafe(Math.max(0, size));
  let offset = 0;
  while (offset < buffer.length) {
    const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
    if (read === 0) break;
    offset += read;
  }
  return buffer.subarray(0, offset);
}

export function replaceFdContent(fd, content) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  fs.ftruncateSync(fd, 0);
  let offset = 0;
  while (offset < data.length) offset += fs.writeSync(fd, data, offset, data.length - offset, offset);
  return data.length;
}

/** Stable identity of file content for optimistic concurrency in the editor. */
export function contentVersion(content) {
  const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ''), 'utf8');
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

function tooLargeError(size, maxBytes) {
  return Object.assign(new Error(`File is too large (${size} bytes, limit ${maxBytes})`), { statusCode: 413, code: 'FILE_TOO_LARGE', size });
}

/** Read a whole regular file from the workspace through a verified descriptor. */
export function readWorkspaceFile(root, input, { maxBytes = Number.POSITIVE_INFINITY } = {}) {
  const handle = openWorkspaceFile(root, input);
  try {
    if (handle.stat.size > maxBytes) throw tooLargeError(handle.stat.size, maxBytes);
    const buffer = readFd(handle.fd, handle.stat.size);
    return { buffer, full: handle.full, rel: handle.rel, stat: handle.stat };
  } finally {
    fs.closeSync(handle.fd);
  }
}

/**
 * Write a regular file in the workspace through a verified descriptor.
 *
 * `guard(previous)` runs before anything is created or truncated; `previous`
 * is the current content as a Buffer, or null when the file does not exist.
 * Throwing from it aborts the write.
 */
export function writeWorkspaceFile(root, input, content, { mkdirs = true, guard = null, readPreviousUpTo = 4 * 1024 * 1024 } = {}) {
  let handle = null;
  let existed = true;
  try {
    handle = openWorkspaceFile(root, input, { write: true });
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    existed = false;
  }
  if (!handle) {
    if (guard) guard(null);
    try {
      handle = openWorkspaceFile(root, input, { write: true, create: true, exclusive: true, mkdirs });
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      existed = true;
      handle = openWorkspaceFile(root, input, { write: true });
    }
  }
  try {
    const previousSize = existed ? handle.stat.size : 0;
    const previous = existed && (guard || previousSize <= readPreviousUpTo) ? readFd(handle.fd, previousSize) : null;
    if (guard && existed) guard(previous);
    const bytes = replaceFdContent(handle.fd, content);
    return { full: handle.full, rel: handle.rel, existed, previous, previousSize, bytes };
  } finally {
    fs.closeSync(handle.fd);
  }
}
