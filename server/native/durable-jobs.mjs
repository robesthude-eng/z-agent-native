import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, DURABLE_JOB_TTL_MS } from './config.mjs';

const JOB_DIR = path.join(DATA_DIR, 'durable-jobs');

function safeSessionId(value) {
  const id = String(value || '');
  if (!/^ses_[A-Za-z0-9]+$/.test(id)) throw new Error('Invalid durable job session id');
  return id;
}

function jobPath(sessionId) {
  return path.join(JOB_DIR, `${safeSessionId(sessionId)}.json`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function cleanModel(model) {
  if (!model?.providerID || !model?.modelID) return null;
  return { providerID: String(model.providerID), modelID: String(model.modelID) };
}

function cleanPlan(plan) {
  if (!plan || !Array.isArray(plan.candidates)) return null;
  const candidates = plan.candidates
    .filter((candidate) => candidate?.providerID && candidate?.modelID)
    .map((candidate) => ({
      providerID: String(candidate.providerID),
      modelID: String(candidate.modelID),
      ...(candidate.providerName ? { providerName: String(candidate.providerName) } : {}),
      ...(candidate.modelName ? { modelName: String(candidate.modelName) } : {}),
      ...(candidate.status ? { status: String(candidate.status) } : {}),
      ...(candidate.source ? { source: String(candidate.source) } : {}),
      free: Boolean(candidate.free),
    }))
    .slice(0, 8);
  if (!candidates.length) return null;
  return {
    candidates,
    explicit: Boolean(plan.explicit),
    expandOnFailure: Boolean(plan.expandOnFailure),
    goal: String(plan.goal || '').slice(0, 8_000),
    generatedAt: Number(plan.generatedAt) || Date.now(),
  };
}

/**
 * One session can have at most one active native turn, so one atomic job file
 * is enough. It intentionally contains no provider keys or attachment bytes.
 */
export function createDurableJob(input) {
  const sessionId = safeSessionId(input?.sessionId);
  const existing = readJson(jobPath(sessionId));
  if (existing) {
    // A job file left behind by a crash used to block the session forever with a
    // permanent 409. After the TTL the stale file is taken over instead.
    const age = Date.now() - Number(existing.updatedAt || existing.createdAt || 0);
    if (!(age > DURABLE_JOB_TTL_MS)) {
      throw Object.assign(new Error('Unfinished durable turn already exists for this session'), { statusCode: 409 });
    }
    try { fs.rmSync(jobPath(sessionId), { force: true }); } catch { /* recreated below */ }
  }
  const now = Date.now();
  const job = {
    version: 1,
    sessionId,
    ownerId: String(input?.ownerId || ''),
    actionId: String(input?.actionId || ''),
    turnId: String(input?.turnId || ''),
    userMessageId: String(input?.userMessageId || ''),
    assistantMessageId: String(input?.assistantMessageId || ''),
    requestedModel: cleanModel(input?.requestedModel),
    goal: String(input?.goal || '').slice(0, 8_000),
    modelPlan: cleanPlan(input?.modelPlan),
    stepBudget: Math.max(1, Math.min(128, Number(input?.stepBudget) || 36)),
    state: 'running',
    checkpoint: {
      phase: 'created',
      stepsUsed: 0,
      gateReminders: 0,
      lastUsage: null,
      savedAt: now,
    },
    createdAt: now,
    updatedAt: now,
    resumeCount: 0,
  };
  writeJsonAtomic(jobPath(sessionId), job);
  return job;
}

export function getDurableJob(sessionId) {
  const job = readJson(jobPath(sessionId));
  return job?.version === 1 && job?.sessionId === String(sessionId) ? job : null;
}

export function updateDurableJob(sessionId, patch = {}) {
  const current = getDurableJob(sessionId);
  if (!current) return null;
  const next = {
    ...current,
    ...patch,
    ...(Object.hasOwn(patch, 'requestedModel') ? { requestedModel: cleanModel(patch.requestedModel) } : {}),
    ...(Object.hasOwn(patch, 'modelPlan') ? { modelPlan: cleanPlan(patch.modelPlan) } : {}),
    checkpoint: patch.checkpoint
      ? { ...(current.checkpoint || {}), ...patch.checkpoint, savedAt: Date.now() }
      : current.checkpoint,
    updatedAt: Date.now(),
  };
  writeJsonAtomic(jobPath(sessionId), next);
  return next;
}

export function checkpointDurableJob(sessionId, checkpoint, extras = {}) {
  return updateDurableJob(sessionId, { ...extras, state: 'running', checkpoint });
}

export function markDurableJobFinalizing(sessionId, final = {}) {
  return updateDurableJob(sessionId, {
    state: 'finalizing',
    final: {
      status: String(final.status || ''),
      reason: String(final.reason || '').slice(0, 500),
      completedAt: Number(final.completedAt) || Date.now(),
    },
  });
}

export function markDurableJobResuming(sessionId) {
  const current = getDurableJob(sessionId);
  if (!current) return null;
  return updateDurableJob(sessionId, {
    state: 'recovering',
    resumeCount: Number(current.resumeCount || 0) + 1,
    checkpoint: { phase: 'runtime_resume' },
  });
}

export function clearDurableJob(sessionId) {
  try { fs.rmSync(jobPath(sessionId), { force: true }); } catch { /* best effort */ }
}

/**
 * Delete durable job files that no recovery will ever pick up again. Without
 * this the directory grows forever and every restart re-reads dead jobs.
 */
export function pruneExpiredDurableJobs(ttlMs = DURABLE_JOB_TTL_MS) {
  let removed = 0;
  for (const job of listDurableJobs()) {
    const age = Date.now() - Number(job.updatedAt || job.createdAt || 0);
    if (age <= ttlMs) continue;
    try { fs.rmSync(jobPath(job.sessionId), { force: true }); removed += 1; } catch { /* keep going */ }
  }
  return removed;
}

export function listDurableJobs() {
  if (!fs.existsSync(JOB_DIR)) return [];
  const out = [];
  for (const entry of fs.readdirSync(JOB_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !/^ses_[A-Za-z0-9]+\.json$/.test(entry.name)) continue;
    const job = readJson(path.join(JOB_DIR, entry.name));
    if (job?.version === 1 && /^ses_[A-Za-z0-9]+$/.test(String(job.sessionId || ''))) out.push(job);
  }
  return out.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
}

export function resetDurableJobsForTests() {
  try { fs.rmSync(JOB_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
}
