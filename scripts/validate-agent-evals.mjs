import fs from 'node:fs';
import path from 'node:path';
import { subagentKinds } from '../server/native/subagents.mjs';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const file = path.join(root, 'evals/coding-agent.json');
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const allowedAgents = new Set(subagentKinds());

if (doc?.version !== 2) throw new Error('eval manifest version must be 2');
if (!Array.isArray(doc?.cases) || doc.cases.length < 30) throw new Error('eval manifest must contain at least 30 executable cases');

function safeRelative(value, where) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error(`${where}: invalid relative path ${value}`);
  return value;
}

const ids = new Set();
for (const [index, item] of doc.cases.entries()) {
  const where = `cases[${index}]`;
  if (!item || typeof item !== 'object') throw new Error(`${where} must be an object`);
  if (typeof item.id !== 'string' || !/^[a-z0-9][a-z0-9-]+$/.test(item.id)) throw new Error(`${where}.id must be a stable kebab-case id`);
  if (ids.has(item.id)) throw new Error(`duplicate eval id: ${item.id}`);
  ids.add(item.id);
  if (!allowedAgents.has(item.agent)) throw new Error(`${item.id}: unsupported agent ${item.agent}`);
  if (typeof item.prompt !== 'string' || item.prompt.trim().length < 40) throw new Error(`${item.id}: prompt is too short`);
  if (!Array.isArray(item.mustMentionPaths) || item.mustMentionPaths.length === 0) throw new Error(`${item.id}: mustMentionPaths is required`);
  if (!Array.isArray(item.mustMentionAny) || item.mustMentionAny.length === 0) throw new Error(`${item.id}: mustMentionAny is required`);
  if (item.workspacePath != null) {
    const relative = safeRelative(item.workspacePath, `${item.id}.workspacePath`);
    if (!fs.existsSync(path.join(root, relative))) throw new Error(`${item.id}: workspacePath does not exist: ${relative}`);
  } else {
    for (const relativeRaw of item.mustMentionPaths) {
      const relative = safeRelative(relativeRaw, `${item.id}.mustMentionPaths`);
      if (!fs.existsSync(path.join(root, relative))) throw new Error(`${item.id}: referenced repository path does not exist: ${relative}`);
    }
  }
  for (const expected of item.expectFiles || []) {
    safeRelative(expected?.path, `${item.id}.expectFiles.path`);
    if (expected?.contains != null && typeof expected.contains !== 'string') throw new Error(`${item.id}: expectFiles.contains must be a string`);
  }
  if (item.verifyCommand != null && (typeof item.verifyCommand !== 'string' || !item.verifyCommand.trim())) throw new Error(`${item.id}: verifyCommand must be a non-empty string`);
  if (item.forbidMutation != null && typeof item.forbidMutation !== 'boolean') throw new Error(`${item.id}: forbidMutation must be boolean`);
  if (item.ciSmoke != null && typeof item.ciSmoke !== 'boolean') throw new Error(`${item.id}: ciSmoke must be boolean`);
}

const counts = Object.fromEntries([...allowedAgents].map((agent) => [agent, doc.cases.filter((item) => item.agent === agent && !item.ciSmoke).length]));
for (const [agent, count] of Object.entries(counts)) if (count < 1) throw new Error(`eval manifest has no non-smoke ${agent} case`);
if (!doc.cases.some((item) => item.ciSmoke)) throw new Error('eval manifest needs at least one deterministic ciSmoke case');

console.log(`coding-agent eval manifest valid: ${doc.cases.length} cases (${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')}, smoke=${doc.cases.filter((item) => item.ciSmoke).length})`);
