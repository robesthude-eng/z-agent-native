import crypto from 'node:crypto';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { parseDocument } from 'yaml';

export const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_FILES = 1500;
export const MAX_SKILL_BYTES = 96_000;
export const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const skillError = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

export function safePackagePath(raw) {
  const value = String(raw);
  if (!value || value.length > 500 || /[\\\x00-\x1f]/.test(value) || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.split('/').some((s) => s === '..' || s === '.')) throw skillError(`Unsafe skill file path: ${value.slice(0, 100)}`);
  return value;
}

export function parseSkillDocument(raw, extra = null) {
  const text = String(raw).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (Buffer.byteLength(text) > MAX_SKILL_BYTES) throw skillError('SKILL.md exceeds 96 KB');
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw skillError('SKILL.md needs YAML frontmatter with name and description');
  const doc = parseDocument(match[1], { uniqueKeys: true, customTags: [] });
  if (doc.errors.length) throw skillError(`Invalid skill YAML: ${doc.errors[0].message}`);
  let meta;
  try { meta = doc.toJS({ maxAliasCount: 0 }); } catch { throw skillError('YAML aliases are not supported'); }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) throw skillError('Skill frontmatter must be a mapping');
  const name = typeof meta.name === 'string' ? meta.name : '';
  const description = typeof meta.description === 'string' ? meta.description.replace(/\s+/g, ' ').trim() : '';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) throw skillError('Skill name must be a lowercase slug, at most 64 characters');
  if (!description || description.length > 1024) throw skillError('Skill description must contain 1–1024 characters');
  if (!match[2].trim()) throw skillError('Skill instructions are empty');
  const warnings = [];
  for (const key of ['hooks', 'context', 'agent', 'shell', 'allowed-tools', 'dependencies']) if (meta[key] != null) warnings.push(`${key}: host-specific metadata is retained but does not execute hooks or grant permissions`);
  if (/!`[^`]+`/.test(text)) warnings.push('Dynamic shell interpolation is not executed by ZetaAgent');
  if (!meta.license) warnings.push('No license declared in frontmatter; check the source license before redistribution');
  if (extra?.dependencies) warnings.push('Declared MCP/tool dependencies require separate configuration');
  return { name, description, content: text, autoUse: meta['disable-model-invocation'] !== true && extra?.policy?.allow_implicit_invocation !== false, warnings, compatibility: typeof meta.compatibility === 'string' ? meta.compatibility.slice(0, 500) : '' };
}

// Inspect central directory BEFORE decompression: traversal, duplicate names,
// special files and zip bombs must not become filesystem writes or allocations.
export function zipManifest(input) {
  const bytes = Buffer.from(input);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { eocd = i; break; }
  if (eocd < 0) throw skillError('Not a supported ZIP archive');
  if (bytes.readUInt16LE(eocd + 4) || bytes.readUInt16LE(eocd + 6)) throw skillError('Multipart ZIP is not supported');
  const count = bytes.readUInt16LE(eocd + 10);
  const offset = bytes.readUInt32LE(eocd + 16);
  const size = bytes.readUInt32LE(eocd + 12);
  if (count === 65535 || offset === 0xffffffff || count > 40000 || offset + size > eocd) throw skillError('ZIP64 or oversized archive directory is not supported');
  const entries = new Map();
  let pos = offset;
  for (let n = 0; n < count; n++) {
    if (pos + 46 > bytes.length || bytes.readUInt32LE(pos) !== 0x02014b50) throw skillError('Invalid ZIP directory');
    const flags = bytes.readUInt16LE(pos + 8), length = bytes.readUInt16LE(pos + 28), extra = bytes.readUInt16LE(pos + 30), comment = bytes.readUInt16LE(pos + 32);
    if (pos + 46 + length + extra + comment > offset + size) throw skillError('Invalid ZIP entry bounds');
    const name = safePackagePath(bytes.subarray(pos + 46, pos + 46 + length).toString('utf8'));
    const mode = bytes.readUInt32LE(pos + 38) >>> 16;
    if (entries.has(name) || flags & 1) throw skillError('Duplicate paths or encrypted ZIP entries are not supported');
    entries.set(name, { name, size: bytes.readUInt32LE(pos + 24), special: (mode & 0xf000) !== 0 && ![0x8000, 0x4000].includes(mode & 0xf000), executable: Boolean(mode & 0o111) });
    pos += 46 + length + extra + comment;
  }
  if (pos !== offset + size) throw skillError('Invalid ZIP central directory size');
  return entries;
}

export function extractSelected(bytes, manifest, names, limit = MAX_PACKAGE_BYTES) {
  let total = 0;
  const selected = new Set(names);
  if (selected.size > MAX_FILES) throw skillError(`Skill package exceeds ${MAX_FILES} files`);
  for (const name of selected) {
    const entry = manifest.get(name);
    if (!entry || entry.special || entry.size > MAX_FILE_BYTES) throw skillError(`Unsupported or oversized skill file: ${name}`);
    total += entry.size;
    if (total > limit) throw skillError('Skill package exceeds the decompressed size limit (16 MB per skill)');
  }
  const files = unzipSync(new Uint8Array(bytes), { filter: (entry) => {
    if (!selected.has(entry.name)) return false;
    if (entry.originalSize !== manifest.get(entry.name)?.size) throw skillError('ZIP size mismatch');
    return true;
  } });
  for (const name of selected) if (!files[name] || files[name].length !== manifest.get(name).size) throw skillError('Incomplete or corrupt ZIP entry');
  return files;
}

export function archiveCandidates(bytes) {
  const manifest = zipManifest(bytes);
  const names = [...manifest.keys()].filter((n) => /(^|\/)SKILL\.md$/.test(n) && !/(^|\/)(node_modules|\.git)\//.test(n));
  if (!names.length) throw skillError('No SKILL.md found in archive');
  if (names.length > 500) throw skillError('Archive has more than 500 skills; select a smaller source');
  const docs = extractSelected(bytes, manifest, names, 16 * 1024 * 1024);
  const candidates = [], invalid = [];
  for (const name of names) {
    try {
      const parsed = parseSkillDocument(Buffer.from(docs[name]).toString('utf8'));
      candidates.push({ ...parsed, path: path.posix.dirname(name) === '.' ? '' : path.posix.dirname(name), hash: digest(docs[name]) });
    } catch (err) { invalid.push({ path: name, error: err.message }); }
  }
  return { manifest, candidates, invalid };
}

export function packageFromArchive(bytes, candidatePath) {
  const { manifest, candidates } = archiveCandidates(bytes);
  const candidate = candidates.find((c) => c.path === candidatePath);
  if (!candidate) throw skillError('Skill path was not found; discover the source first');
  const prefix = candidate.path ? `${candidate.path}/` : '';
  const names = [...manifest.keys()].filter((n) => n.startsWith(prefix) && !n.endsWith('/') && !/(^|\/)(\.git|node_modules|\.env(?:\.[^/]*)?|\.ssh|\.aws)(\/|$)/.test(n.slice(prefix.length)));
  const extracted = extractSelected(bytes, manifest, names);
  const files = {};
  for (const name of names) files[safePackagePath(name.slice(prefix.length))] = { base64: Buffer.from(extracted[name]).toString('base64'), executable: manifest.get(name).executable };
  let extra;
  if (files['agents/openai.yaml']) {
    try { extra = parseDocument(Buffer.from(files['agents/openai.yaml'].base64, 'base64').toString('utf8')).toJS({ maxAliasCount: 0 }); } catch { candidate.warnings.push('agents/openai.yaml could not be parsed'); }
  }
  const parsed = parseSkillDocument(candidate.content, extra);
  const packageHash = digest(JSON.stringify(files));
  return { ...parsed, files, hash: packageHash, fileCount: names.length, bytes: names.reduce((n, k) => n + manifest.get(k).size, 0) };
}
