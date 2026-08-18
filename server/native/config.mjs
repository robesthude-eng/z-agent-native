import path from 'node:path';

export const PORT = Number.parseInt(process.env.PORT || '3000', 10);
export const DATA_DIR = path.resolve(process.env.Z_AGENT_DATA_DIR || './data');
export const DB_PATH = path.join(DATA_DIR, 'z-agent.sqlite');
export const WORKSPACES_DIR = path.resolve(process.env.Z_AGENT_WORKSPACES_DIR || './workspaces');
export const DIST_DIR = path.resolve(process.env.Z_AGENT_DIST_DIR || './dist');
export const SESSION_TTL_MS = Number.parseInt(process.env.Z_AGENT_SESSION_TTL_MS || '', 10) || 7 * 24 * 60 * 60 * 1000;
export const MAX_JSON_BYTES = Number.parseInt(process.env.Z_AGENT_MAX_JSON_BYTES || '', 10) || 8 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = Number.parseInt(process.env.Z_AGENT_MAX_UPLOAD_BYTES || '', 10) || 250 * 1024 * 1024;
// Hard ceiling for one turn. Z_AGENT_MAX_STEPS pins the budget exactly;
// without it the runtime derives a budget from task complexity and clamps it here.
export const MAX_AGENT_STEPS = Number.parseInt(process.env.Z_AGENT_MAX_STEPS || '', 10) || 0;
export const MAX_AGENT_STEPS_CEILING = 128;
export const DEFAULT_TOOL_TIMEOUT_MS = Number.parseInt(process.env.Z_AGENT_TOOL_TIMEOUT_MS || '', 10) || 120_000;
export const EVENT_RING_SIZE = 1000;
export const INVITE_CODE = process.env.Z_AGENT_INVITE_CODE || '';
// Registration is fail-closed: after the bootstrap admin exists, a new account
// requires either an invite code or an explicit opt-in to open registration.
export const ALLOW_OPEN_REGISTRATION = process.env.Z_AGENT_ALLOW_OPEN_REGISTRATION === '1';
// Only trust X-Forwarded-For when the runtime really sits behind a reverse proxy.
export const TRUST_PROXY = process.env.Z_AGENT_TRUST_PROXY === '1';
// Optional explicit browser origins (needed when the public origin differs from Host).
export const ALLOWED_ORIGINS = String(process.env.Z_AGENT_ALLOWED_ORIGINS || '')
  .split(',').map((value) => value.trim()).filter(Boolean);
export const GREP_TIMEOUT_MS = Number.parseInt(process.env.Z_AGENT_GREP_TIMEOUT_MS || '', 10) || 5_000;
export const DURABLE_JOB_TTL_MS = Number.parseInt(process.env.Z_AGENT_DURABLE_JOB_TTL_MS || '', 10) || 24 * 60 * 60 * 1000;
export const MAX_INFLIGHT_UPLOAD_BYTES = Number.parseInt(process.env.Z_AGENT_MAX_INFLIGHT_UPLOAD_BYTES || '', 10) || 512 * 1024 * 1024;
export const SECURE_COOKIES = process.env.Z_AGENT_SECURE_COOKIES === '1';

export const ALLOW_UNISOLATED_SHELL = process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL === '1';
