import path from 'node:path';

export const PORT = Number.parseInt(process.env.PORT || '3000', 10);
export const DATA_DIR = path.resolve(process.env.Z_AGENT_DATA_DIR || './data');
export const DB_PATH = path.join(DATA_DIR, 'z-agent.sqlite');
export const WORKSPACES_DIR = path.resolve(process.env.Z_AGENT_WORKSPACES_DIR || './workspaces');
export const DIST_DIR = path.resolve(process.env.Z_AGENT_DIST_DIR || './dist');
export const SESSION_TTL_MS = Number.parseInt(process.env.Z_AGENT_SESSION_TTL_MS || '', 10) || 7 * 24 * 60 * 60 * 1000;
export const MAX_JSON_BYTES = Number.parseInt(process.env.Z_AGENT_MAX_JSON_BYTES || '', 10) || 8 * 1024 * 1024;
export const MAX_UPLOAD_BYTES = Number.parseInt(process.env.Z_AGENT_MAX_UPLOAD_BYTES || '', 10) || 250 * 1024 * 1024;
export const MAX_AGENT_STEPS = Number.parseInt(process.env.Z_AGENT_MAX_STEPS || '', 10) || 32;
export const DEFAULT_TOOL_TIMEOUT_MS = Number.parseInt(process.env.Z_AGENT_TOOL_TIMEOUT_MS || '', 10) || 120_000;
export const EVENT_RING_SIZE = 1000;
export const INVITE_CODE = process.env.Z_AGENT_INVITE_CODE || '';
export const SECURE_COOKIES = process.env.Z_AGENT_SECURE_COOKIES === '1';

export const ALLOW_UNISOLATED_SHELL = process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL === '1';
