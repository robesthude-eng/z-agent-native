import fs from 'node:fs';

const file = new URL('../evals/coding-agent.json', import.meta.url);
const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
const allowedAgents = new Set(['explore', 'debug', 'review']);

if (doc?.version !== 1) throw new Error('eval manifest version must be 1');
if (!Array.isArray(doc?.cases) || doc.cases.length < 3) throw new Error('eval manifest must contain at least 3 cases');

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
  for (const relative of item.mustMentionPaths) {
    if (typeof relative !== 'string' || relative.startsWith('/') || relative.includes('..')) throw new Error(`${item.id}: invalid path ${relative}`);
    const target = new URL(`../${relative}`, import.meta.url);
    if (!fs.existsSync(target)) throw new Error(`${item.id}: referenced repository path does not exist: ${relative}`);
  }
}

const counts = Object.fromEntries([...allowedAgents].map((agent) => [agent, doc.cases.filter((item) => item.agent === agent).length]));
for (const [agent, count] of Object.entries(counts)) if (count === 0) throw new Error(`eval manifest has no ${agent} case`);

console.log(`coding-agent eval manifest valid: ${doc.cases.length} cases (${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(', ')})`);
