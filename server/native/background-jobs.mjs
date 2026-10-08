// Фоновые задачи агента: долгие команды (сборка, обучение, скачивание)
// запускаются отвязанными от хода (setsid), пишут лог в
// .agent-home/jobs/<id>/ и не упираются в таймаут инструмента. Агент может
// заниматься другим, проверять статус или ждать. Если задача с notify
// завершилась, когда агент уже ответил, сервер сам продолжает чат новым
// ходом с итогом задачи.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACES_DIR } from './config.mjs';
import { syncSandboxOwnership } from './sandbox.mjs';
import { safeWorkspacePath } from './security.mjs';
import { db } from './store.mjs';
import { execBash } from './tools/shell.mjs';
import { assertShellCommandAllowed } from './workspace-policy.mjs';

const JOBS_REL = '.agent-home/jobs';
const MAX_JOBS_PER_CHAT = 30;
const MAX_RUNNING_PER_CHAT = 4;
const WATCH_INTERVAL_MS = 10_000;
const WAIT_POLL_MS = 500;
const LIVENESS_EVERY_MS = 60_000;
const JOB_ID_RE = /^job_[A-Za-z0-9_-]{6,32}$/;

// Папка задач лежит в песочнице, а читает и пишет её сервер от root.
// Поэтому любой путь проходит safeWorkspacePath (без symlink-ов), а записи
// создаются с O_EXCL — подложенная ссылка не даст писать мимо папки.
function jobsDir(root) {
  return safeWorkspacePath(root, JOBS_REL, { allowMissing: true });
}

function jobDir(root, id) {
  if (!JOB_ID_RE.test(String(id || ''))) throw Object.assign(new Error(`Unknown background job id: ${id}`), { statusCode: 400 });
  return safeWorkspacePath(root, `${JOBS_REL}/${id}`, { allowMissing: true });
}

function jobFile(dir, name) {
  const full = path.join(dir, name);
  try {
    if (fs.lstatSync(full).isSymbolicLink()) throw Object.assign(new Error('Symlink in job directory'), { statusCode: 403 });
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  return full;
}

function writeExclusive(file, data) {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, data, { flag: 'wx' });
}

function readNoFollow(file, maxBytes = 1024 * 1024, fromEnd = false) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return '';
    const len = Math.min(st.size, maxBytes);
    const start = fromEnd ? st.size - len : 0;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return { text: buf.toString('utf8'), truncated: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

function readMeta(dir) {
  try {
    return JSON.parse(readNoFollow(jobFile(dir, 'meta.json'), 256 * 1024).text);
  } catch {
    return null;
  }
}

function writeMeta(dir, meta) {
  const tmp = path.join(dir, `.meta.${process.pid}.tmp`);
  writeExclusive(tmp, JSON.stringify(meta, null, 2));
  fs.renameSync(tmp, path.join(dir, 'meta.json'));
}

function readExit(dir) {
  try {
    const raw = String(readNoFollow(jobFile(dir, 'exit_code'), 64).text || '').trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

export function tailFile(file, maxLines = 40, maxBytes = 64 * 1024) {
  try {
    const r = readNoFollow(file, maxBytes, true);
    if (!r) return '';
    const lines = r.text.split('\n');
    if (r.truncated) lines.shift();
    return lines.slice(-maxLines).join('\n').trimEnd();
  } catch {
    return '';
  }
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function jobState(root, meta) {
  const dir = jobDir(root, meta.id);
  const exitCode = readExit(dir);
  const status = exitCode != null ? (exitCode === 0 ? 'succeeded' : 'failed') : meta.lost ? 'lost' : 'running';
  const finishedAt =
    exitCode != null
      ? meta.finishedAt ||
        (() => {
          try {
            return Math.round(fs.lstatSync(path.join(dir, 'exit_code')).mtimeMs);
          } catch {
            return Date.now();
          }
        })()
      : null;
  return { ...meta, status, exitCode, finishedAt, durationMs: (finishedAt || Date.now()) - meta.startedAt };
}

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

function describe(root, job, lines = 30) {
  const log = tailFile(path.join(jobDir(root, job.id), 'output.log'), lines);
  return [
    `job ${job.id} "${job.name}": ${job.status}${job.exitCode != null ? ` (exit ${job.exitCode})` : ''}, ${formatDuration(job.durationMs)}`,
    `command: ${job.command}`,
    `log: ${JOBS_REL}/${job.id}/output.log`,
    log ? `last ${lines} lines:\n${log}` : '(no output yet)',
  ].join('\n');
}

export function listJobs(root) {
  let names = [];
  try {
    names = fs.readdirSync(jobsDir(root));
  } catch {
    return [];
  }
  return names
    .filter((n) => JOB_ID_RE.test(n))
    .map((n) => readMeta(path.join(jobsDir(root), n)))
    .filter(Boolean)
    .map((m) => jobState(root, m))
    .sort((a, b) => b.startedAt - a.startedAt);
}

async function checkAlive(root, job, ctx) {
  if (!job.pid) return true;
  try {
    const r = await execBash(root, `kill -0 ${Number(job.pid)} 2>/dev/null && echo alive || echo dead`, 10_000, ctx.signal, {
      sessionId: ctx.sessionId,
    });
    return !/dead/.test(String(r.stdout || ''));
  } catch {
    return true;
  }
}

async function markLostIfDead(root, job, ctx) {
  if (job.status !== 'running') return job;
  if (await checkAlive(root, job, ctx)) return job;
  // Повторно смотрим exit_code: процесс мог завершиться между проверками.
  if (readExit(jobDir(root, job.id)) != null) return jobState(root, readMeta(jobDir(root, job.id)));
  const dir = jobDir(root, job.id);
  const meta = { ...readMeta(dir), lost: true };
  writeMeta(dir, meta);
  return jobState(root, meta);
}

function acknowledge(root, id) {
  const dir = jobDir(root, id);
  const meta = readMeta(dir);
  if (meta && !meta.acknowledged && readExit(dir) != null) {
    meta.acknowledged = true;
    writeMeta(dir, meta);
  }
}

async function startJob(root, input, ctx) {
  const command = String(input?.command || '').trim();
  if (!command) throw new Error('background start requires command');
  assertShellCommandAllowed(command);
  const existing = listJobs(root);
  if (existing.filter((j) => j.status === 'running').length >= MAX_RUNNING_PER_CHAT) {
    throw new Error(`Already ${MAX_RUNNING_PER_CHAT} background jobs running in this chat; wait for or kill one first.`);
  }
  // Старые завершённые задачи чистим, чтобы папка не росла бесконечно.
  for (const old of existing.slice(MAX_JOBS_PER_CHAT - 1)) {
    if (old.status !== 'running') fs.rmSync(jobDir(root, old.id), { recursive: true, force: true });
  }
  const id = `job_${crypto.randomBytes(6).toString('base64url')}`;
  const dir = jobDir(root, id);
  fs.mkdirSync(dir, { recursive: true });
  const cwdRel = String(input?.cwd || '').trim();
  const cwd = cwdRel ? path.resolve(root, cwdRel) : root;
  if (cwd !== root && !cwd.startsWith(`${root}${path.sep}`)) throw new Error('cwd must stay inside the workspace');
  writeExclusive(path.join(dir, 'cmd.sh'), `#!/bin/bash\ncd ${shellQuote(cwd)} || exit 97\n${command}\n`);
  const meta = {
    id,
    name: String(input?.name || command.split('\n')[0]).slice(0, 80),
    command: command.slice(0, 2000),
    cwd: cwdRel || '.',
    startedAt: Date.now(),
    notify: input?.notify !== false,
    acknowledged: false,
    notified: false,
    requestedModel: ctx.requestedModel || null,
    pid: null,
  };
  writeMeta(dir, meta);
  if (ctx.sessionId) {
    try {
      syncSandboxOwnership(ctx.sessionId, root, jobsDir(root));
    } catch {}
  }
  const q = (f) => shellQuote(path.join(dir, f));
  // Ждём, пока задача отвяжется (setsid) и запишет свой pid: иначе завершение
  // запускающей оболочки может прибить её группу до отвязки.
  const launcher = [
    `setsid nohup bash -c 'echo $$ > "$3"; bash "$0" > "$1" 2>&1; echo $? > "$2.tmp" && mv "$2.tmp" "$2"' ${q('cmd.sh')} ${q('output.log')} ${q('exit_code')} ${q('pid')} > /dev/null 2>&1 < /dev/null &`,
    `for i in $(seq 1 100); do [ -s ${q('pid')} ] && break; sleep 0.05; done`,
    `cat ${q('pid')}`,
  ].join('\n');
  const r = await execBash(root, launcher, 20_000, ctx.signal, ctx);
  const pid = Number(
    String(r.stdout || '')
      .trim()
      .split('\n')
      .pop(),
  );
  if (r.code !== 0 || !Number.isInteger(pid)) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`Failed to start background job: ${r.stderr || r.stdout || `exit ${r.code}`}`);
  }
  meta.pid = pid;
  writeMeta(dir, meta);
  if (meta.notify && ctx.sessionId) watchJob(ctx.sessionId, root, id);
  return {
    output: [
      `Started background job ${id} "${meta.name}" (pid ${pid}).`,
      `Log: ${JOBS_REL}/${id}/output.log. It keeps running after this turn ends.`,
      'Do other useful work meanwhile, check it with background action=status or block with action=wait.',
      meta.notify ? 'If it finishes after you have already answered, the chat will be resumed automatically with its result.' : '',
    ]
      .filter(Boolean)
      .join('\n'),
    title: `Фоновая задача: ${meta.name}`,
    metadata: { background: { action: 'start', id, pid } },
  };
}

export async function executeBackgroundTool(root, input, ctx = {}) {
  const action = String(input?.action || '').toLowerCase();
  if (action === 'start') return await startJob(root, input, ctx);
  if (action === 'list') {
    const jobs = listJobs(root);
    return {
      output: jobs.length
        ? jobs
            .map(
              (j) =>
                `${j.id} "${j.name}": ${j.status}${j.exitCode != null ? ` (exit ${j.exitCode})` : ''}, ${formatDuration(j.durationMs)}`,
            )
            .join('\n')
        : 'No background jobs in this chat.',
      title: 'Фоновые задачи',
    };
  }
  const id = String(input?.id || '');
  const dir = jobDir(root, id);
  const meta = readMeta(dir);
  if (!meta) throw new Error(`Unknown background job id: ${id}. Use action=list.`);
  const lines = Math.min(400, Math.max(5, Number(input?.lines) || 40));
  if (action === 'status' || action === 'logs') {
    const job = await markLostIfDead(root, jobState(root, meta), ctx);
    if (job.status !== 'running') acknowledge(root, id);
    return {
      output: describe(root, job, action === 'logs' ? Math.max(lines, 120) : lines),
      title: `${job.name}: ${job.status}`,
      metadata: { background: { action, id, status: job.status, exitCode: job.exitCode } },
    };
  }
  if (action === 'wait') {
    const timeoutMs = Math.min(1800, Math.max(5, Number(input?.timeoutSec) || 600)) * 1000;
    const deadline = Date.now() + timeoutMs;
    let lastLiveness = Date.now();
    const waitStarted = Date.now();
    let lastShown = '';
    let job = jobState(root, meta);
    while (job.status === 'running' && Date.now() < deadline) {
      if (ctx.signal?.aborted) throw Object.assign(new Error('Turn cancelled'), { name: 'AbortError' });
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
      // Live tail of the job log: refreshed twice a second and only when it
      // changed, with a header that shows the job is alive even when it is quiet.
      if (typeof ctx.onOutput === 'function') {
        const tail = tailFile(path.join(dir, 'output.log'), 30);
        const text = `${meta.name || id}: работает ${formatDuration(Date.now() - waitStarted)}${tail ? `\n${tail}` : '\n(пока нет вывода)'}`;
        const key = `${tail.length}:${tail.slice(-200)}:${Math.floor((Date.now() - waitStarted) / 1000)}`;
        if (key !== lastShown) {
          lastShown = key;
          try {
            ctx.onOutput(text);
          } catch {}
        }
      }
      job = jobState(root, readMeta(dir) || meta);
      if (job.status === 'running' && Date.now() - lastLiveness > LIVENESS_EVERY_MS) {
        lastLiveness = Date.now();
        job = await markLostIfDead(root, job, ctx);
      }
    }
    if (job.status !== 'running') acknowledge(root, id);
    const prefix = job.status === 'running' ? `Still running after waiting ${Math.round(timeoutMs / 1000)}s.\n` : '';
    return {
      output: prefix + describe(root, job, lines),
      title: `${job.name}: ${job.status}`,
      metadata: { background: { action, id, status: job.status, exitCode: job.exitCode } },
    };
  }
  if (action === 'kill') {
    const job = jobState(root, meta);
    if (job.status === 'running' && meta.pid) {
      await execBash(
        root,
        `kill -TERM -- -${Number(meta.pid)} 2>/dev/null || kill -TERM ${Number(meta.pid)} 2>/dev/null; sleep 1; kill -KILL -- -${Number(meta.pid)} 2>/dev/null; true`,
        15_000,
        ctx.signal,
        ctx,
      );
    }
    const next = { ...readMeta(dir), acknowledged: true, killed: true };
    writeMeta(dir, next);
    if (readExit(dir) == null) writeExclusive(jobFile(dir, 'exit_code'), '143\n');
    return {
      output: `Killed ${id}.\n${describe(root, jobState(root, next), 10)}`,
      title: `Остановлено: ${meta.name}`,
      metadata: { background: { action, id } },
    };
  }
  throw new Error('background action must be start, status, logs, wait, kill or list');
}

// ---- Автопродолжение чата по завершении задачи ----------------------------

const watched = new Map(); // `${sessionId}:${id}` -> { sessionId, root, id }
let timer = null;
let hooks = null;

/** Хуки задаёт runner: isTurnActive(sessionId) и submit({ sessionId, ownerId, text, model }). */
export function configureBackgroundJobHooks(next) {
  hooks = next;
  ensureTimer();
}

function ensureTimer() {
  if (timer || !watched.size || !hooks) return;
  timer = setInterval(() => {
    tick().catch((err) => console.warn('[background-jobs]', err?.message || err));
  }, WATCH_INTERVAL_MS);
  timer.unref?.();
}

export function watchJob(sessionId, root, id) {
  watched.set(`${sessionId}:${id}`, { sessionId, root, id });
  ensureTimer();
}

export function notificationText(job, log) {
  const ok = job.status === 'succeeded';
  return [
    `🔔 Фоновая задача «${job.name}» ${ok ? 'завершилась успешно' : job.status === 'lost' ? 'прервалась (процесс пропал)' : `завершилась с ошибкой (код ${job.exitCode})`} за ${formatDuration(job.durationMs)}.`,
    log ? `\nПоследние строки вывода:\n\`\`\`\n${log.slice(-3000)}\n\`\`\`` : '',
    `\nПродолжи исходную задачу с учётом этого результата. Полный лог: \`${JOBS_REL}/${job.id}/output.log\`.`,
  ].join('\n');
}

async function tick() {
  for (const [key, w] of watched) {
    let dir;
    try {
      dir = jobDir(w.root, w.id);
    } catch {
      watched.delete(key);
      continue;
    }
    const meta = readMeta(dir);
    if (!meta?.notify || meta.notified || meta.acknowledged) {
      watched.delete(key);
      continue;
    }
    const job = jobState(w.root, meta);
    if (job.status === 'running') continue;
    if (hooks.isTurnActive(w.sessionId)) continue; // агент ещё работает — он может забрать результат сам
    // Владельца берём только из базы: meta.json лежит в песочнице и может быть изменён агентом.
    const owner = db.prepare('SELECT owner_id FROM chats WHERE id=?').get(w.sessionId)?.owner_id;
    if (!owner) {
      watched.delete(key);
      continue;
    }
    writeMeta(dir, { ...meta, notified: true });
    watched.delete(key);
    try {
      const model =
        meta.requestedModel && typeof meta.requestedModel === 'object'
          ? { providerID: String(meta.requestedModel.providerID || ''), modelID: String(meta.requestedModel.modelID || '') }
          : null;
      await hooks.submit({
        sessionId: w.sessionId,
        ownerId: owner,
        model,
        text: notificationText(job, tailFile(path.join(dir, 'output.log'), 30)),
      });
    } catch (err) {
      console.warn(`[background-jobs] resume ${w.sessionId} failed: ${err?.message || err}`);
    }
  }
  if (!watched.size && timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** После рестарта сервера заново подхватываем незакрытые задачи с notify. */
export function rescanBackgroundJobs() {
  let sessions = [];
  try {
    sessions = db
      .prepare('SELECT id FROM chats')
      .all()
      .map((r) => r.id);
  } catch {
    return 0;
  }
  let n = 0;
  for (const sid of sessions) {
    const root = path.join(WORKSPACES_DIR, sid);
    for (const job of listJobs(root)) {
      if (job.notify && !job.notified && !job.acknowledged) {
        watchJob(sid, root, job.id);
        n += 1;
      }
    }
  }
  return n;
}

export function backgroundJobsTickForTests() {
  return tick();
}
