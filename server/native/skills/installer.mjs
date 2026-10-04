import { safeExternalFetch } from '../security.mjs';
import { parseDocument } from 'yaml';
import { archiveCandidates, digest, MAX_SOURCE_BYTES, MAX_FILES, MAX_FILE_BYTES, MAX_PACKAGE_BYTES, safePackagePath, packageFromArchive, parseSkillDocument, skillError } from './package.mjs';

// Bounded ephemeral download cache: upload IDs are owner-scoped and expire.
const sources = new Map();
const activeOwners = new Set();
const CACHE_TTL = 10 * 60_000;
const MAX_CACHE_BYTES = 80 * 1024 * 1024;
let fetcher = safeExternalFetch;
export function setSkillFetcherForTests(fn) { fetcher = typeof fn === 'function' ? fn : safeExternalFetch; }

async function download(value, signal, limit = MAX_SOURCE_BYTES) {
  let url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw skillError('Skill sources must use HTTPS without embedded credentials');
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetcher(url.href, { signal: combined, headers: { 'user-agent': 'ZetaAgent-SkillInstaller', accept: '*/*' } });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const next = res.headers.get('location');
        await res.body?.cancel();
        if (!next) throw skillError('Source redirect has no location');
        url = new URL(next, url);
        if (url.protocol !== 'https:' || url.username || url.password) throw skillError('Unsafe source redirect');
        continue;
      }
      if (!res.ok) { await res.body?.cancel(); throw skillError(`Source download failed: HTTP ${res.status}. For GitHub, use a public repository and check the API rate limit.`, 502); }
      if (Number(res.headers.get('content-length')) > limit) { await res.body?.cancel(); throw skillError('Skill source exceeds download size limit'); }
      const chunks = [];
      let size = 0;
      if (res.body) for await (const chunk of res.body) {
        size += chunk.byteLength;
        if (size > limit) { controller.abort(); throw skillError('Skill source exceeds download size limit'); }
        chunks.push(Buffer.from(chunk));
      }
      return { bytes: Buffer.concat(chunks), contentType: res.headers.get('content-type') || '', url: url.href };
    }
    throw skillError('Too many source redirects');
  } finally { clearTimeout(timer); }
}

function cache(ownerId, entry) {
  for (const [key, value] of sources) if (Date.now() - value.created > CACHE_TTL) sources.delete(key);
  const id = `skill-source://${digest(`${ownerId}\0${entry.info.url}\0${entry.info.revision || ''}\0${digest(entry.bytes)}`)}`;
  sources.delete(id);
  let size = [...sources.values()].reduce((n, s) => n + s.bytes.length, 0);
  while (size + entry.bytes.length > MAX_CACHE_BYTES && sources.size) {
    const key = sources.keys().next().value;
    size -= sources.get(key).bytes.length;
    sources.delete(key);
  }
  sources.set(id, { ...entry, ownerId, created: Date.now() });
  return id;
}

function cached(ownerId, id) {
  const entry = sources.get(id);
  if (!entry || entry.ownerId !== ownerId || Date.now() - entry.created > CACHE_TTL) throw skillError('Source preview expired; discover or upload it again', 410);
  return entry;
}

function githubSource(raw, explicitRef = '') {
  const u = new URL(raw);
  if (u.protocol !== 'https:' || u.username || u.password) throw skillError('Skill sources must use HTTPS without embedded credentials');
  if (!['github.com', 'raw.githubusercontent.com'].includes(u.hostname)) return null;
  if (/\.zip$/i.test(u.pathname) || /\/releases\/download\//.test(u.pathname) || /\/raw\//.test(u.pathname)) return null;
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const owner = parts[0], repo = parts[1]?.replace(/\.git$/, '');
  if (!owner || !repo || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) throw skillError('Invalid GitHub repository URL');
  let ref = explicitRef || 'HEAD', scope = '';
  if (u.hostname === 'raw.githubusercontent.com') { ref = explicitRef || parts[2]; scope = parts.slice(3).join('/'); }
  else if (['tree', 'blob'].includes(parts[2])) { ref = explicitRef || parts[3]; scope = parts.slice(4).join('/'); }
  else if (parts.length > 2) throw skillError('Use a GitHub repository, tree, or SKILL.md link');
  if (!ref || ref.length > 200) throw skillError('Invalid GitHub ref');
  if (scope.endsWith('/SKILL.md')) scope = scope.slice(0, -9);
  else if (scope === 'SKILL.md') scope = '';
  return { owner, repo, ref, scope };
}

function preview(id, entry) {
  if (entry.github) return { source: id, origin: entry.info, candidates: entry.candidates.map((c) => ({ ...c, content: undefined })), invalid: entry.invalid, links: [] };
  if (entry.document) {
    const parsed = parseSkillDocument(entry.bytes.toString('utf8'));
    return { source: id, origin: entry.info, candidates: [{ ...parsed, content: undefined, path: '', hash: digest(entry.bytes) }], invalid: [], links: [] };
  }
  const { candidates, invalid } = archiveCandidates(entry.bytes);
  const root = entry.root || '';
  const relative = (p) => root && p.startsWith(root) ? p.slice(root.length).replace(/^\//, '') : p;
  const inScope = (p) => !entry.scope || p === entry.scope || p.startsWith(`${entry.scope}/`);
  return {
    source: id, origin: entry.info,
    candidates: candidates.map((c) => ({ ...c, path: relative(c.path), content: undefined })).filter((c) => inScope(c.path)),
    invalid: invalid.map((c) => ({ ...c, path: relative(c.path) })).filter((c) => inScope(c.path)), links: [],
  };
}

export async function discoverSkills(ownerId, input, signal) {
  if (activeOwners.has(ownerId) || activeOwners.size >= 2) throw skillError('Another skill download is in progress; retry shortly', 429);
  activeOwners.add(ownerId);
  try { return await discoverSource(ownerId, input, signal); }
  finally { activeOwners.delete(ownerId); }
}

async function discoverSource(ownerId, input, signal) {
  if (String(input.source || '').startsWith('skill-source://')) return preview(input.source, cached(ownerId, input.source));
  if (input.contentBase64) {
    const raw = String(input.contentBase64);
    if (raw.length > Math.ceil(MAX_SOURCE_BYTES * 4 / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw skillError('Invalid or oversized skill upload');
    const bytes = Buffer.from(raw, 'base64');
    const filename = String(input.filename || '').slice(0, 180);
    const document = !bytes.subarray(0, 2).equals(Buffer.from('PK'));
    const entry = { bytes, document, info: { type: 'upload', url: filename, revision: digest(bytes) } };
    return preview(cache(ownerId, entry), entry);
  }
  const source = String(input.source || '').trim();
  if (!source) throw skillError('Provide a GitHub/HTTPS URL or upload SKILL.md/ZIP');
  let gh;
  try { gh = githubSource(source, input.ref); } catch (err) { if (err.statusCode) throw err; throw skillError('Invalid skill source URL'); }
  if (gh) {
    const commit = await download(`https://api.github.com/repos/${gh.owner}/${gh.repo}/commits/${encodeURIComponent(gh.ref)}`, signal, 4 * 1024 * 1024);
    const data = JSON.parse(commit.bytes.toString('utf8'));
    if (!/^[a-f0-9]{40}$/.test(data.sha || '')) throw skillError('GitHub did not return a valid commit');
    const treeData = JSON.parse((await download(`https://api.github.com/repos/${gh.owner}/${gh.repo}/git/trees/${data.commit.tree.sha}?recursive=1`, signal, 12 * 1024 * 1024)).bytes.toString('utf8'));
    if (treeData.truncated || !Array.isArray(treeData.tree)) throw skillError('GitHub file tree is truncated; choose a smaller repository');
    const tree = treeData.tree.filter((f) => f.type === 'blob');
    const paths = tree.filter((f) => /(^|\/)SKILL\.md$/.test(f.path) && (!gh.scope || f.path === `${gh.scope}/SKILL.md` || f.path.startsWith(`${gh.scope}/`)));
    if (paths.length > 500) throw skillError('More than 500 skills found; choose a subdirectory');
    const candidates = [], invalid = [];
    const info = { type: 'github', url: `https://github.com/${gh.owner}/${gh.repo}`, revision: data.sha, ref: gh.ref };
    await mapLimited(paths, async (file) => {
      try {
        if (!['100644', '100755'].includes(file.mode) || file.size > 96000) throw skillError('SKILL.md is a symlink or exceeds 96 KB');
        safePackagePath(file.path);
        const bytes = await githubFile(info, file.path, signal, 96000);
        const parsed = parseSkillDocument(bytes.toString('utf8'));
        candidates.push({ ...parsed, path: file.path === 'SKILL.md' ? '' : file.path.slice(0, -9), hash: digest(bytes) });
      } catch (err) {
        if (signal?.aborted) throw err;
        invalid.push({ path: file.path, error: err.message });
      }
    });
    candidates.sort((a, b) => a.path.localeCompare(b.path));
    const entry = { github: true, tree, candidates, invalid, info, bytes: Buffer.from(JSON.stringify({ tree, candidates })) };
    return preview(cache(ownerId, entry), entry);
  }
  const { bytes, contentType, url } = await download(source, signal);
  const document = !bytes.subarray(0, 2).equals(Buffer.from('PK'));
  if (document && (/text\/html/i.test(contentType) || /^\s*(?:<!doctype|<html)/i.test(bytes.toString('utf8', 0, 200)))) {
    if (bytes.length > 4 * 1024 * 1024) throw skillError('Article is too large');
    const links = new Set();
    for (const match of bytes.toString('utf8').matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
      try {
        const u = new URL(match[1].replace(/&amp;/g, '&'), url);
        if (u.protocol === 'https:' && !u.username && !u.password && (/^(github\.com|raw\.githubusercontent\.com)$/.test(u.hostname) || /\.(zip|md)$/i.test(u.pathname))) links.add(u.href);
      } catch { /* Not a source link. */ }
    }
    return { source, origin: { type: 'article', url }, candidates: [], invalid: [], links: [...links].slice(0, 30) };
  }
  const entry = { bytes, document, info: { type: document ? 'document' : 'zip', url, revision: digest(bytes) } };
  return preview(cache(ownerId, entry), entry);
}

export async function resolveInstallPackage(ownerId, input, signal) {
  const discovered = await discoverSkills(ownerId, input, signal);
  if (discovered.links.length && !discovered.candidates.length) throw skillError('This is an article, not a skill. Discover one of its source links first.');
  let candidate;
  if (input.path != null) candidate = discovered.candidates.find((c) => c.path === input.path);
  else if (input.name) candidate = discovered.candidates.find((c) => c.name === input.name);
  else if (discovered.candidates.length === 1) [candidate] = discovered.candidates;
  if (!candidate) throw skillError('Choose a specific skill path from discover; installing an entire repository implicitly is not allowed');
  const entry = cached(ownerId, discovered.source);
  const pkg = entry.document
    ? { ...parseSkillDocument(entry.bytes.toString('utf8')), files: { 'SKILL.md': { base64: entry.bytes.toString('base64'), executable: false } }, hash: digest(entry.bytes), bytes: entry.bytes.length, fileCount: 1 }
    : entry.github ? await packageFromGithub(entry, entry.candidates.find((c) => c.path === candidate.path), signal) : packageFromArchive(entry.bytes, entry.root ? `${entry.root}${candidate.path ? `/${candidate.path}` : ''}` : candidate.path);
  return { ...pkg, source: { ...entry.info, path: candidate.path, hash: pkg.hash, bytes: pkg.bytes, fileCount: pkg.fileCount, installedAt: Date.now() } };
}

async function mapLimited(items, fn) {
  let index = 0;
  const workers = Array.from({ length: Math.min(4, items.length) }, async () => {
    while (index < items.length) { const item = items[index++]; await fn(item); }
  });
  await Promise.all(workers);
}

async function githubFile(info, file, signal, limit = MAX_FILE_BYTES) {
  const repo = info.url.replace('https://github.com/', '');
  return (await download(`https://raw.githubusercontent.com/${repo}/${info.revision}/${file.split('/').map(encodeURIComponent).join('/')}`, signal, limit)).bytes;
}

async function packageFromGithub(entry, candidate, signal) {
  const prefix = candidate.path ? `${candidate.path}/` : '';
  const tree = entry.tree.filter((f) => f.path.startsWith(prefix) && !/(^|\/)(\.git|node_modules|\.env(?:\.[^/]*)?|\.ssh|\.aws)(\/|$)/.test(f.path.slice(prefix.length)));
  if (tree.length > MAX_FILES) throw skillError(`Skill package exceeds ${MAX_FILES} files`);
  let total = 0;
  for (const file of tree) {
    safePackagePath(file.path);
    if (!['100644', '100755'].includes(file.mode) || file.size > MAX_FILE_BYTES || !Number.isInteger(file.size)) throw skillError(`Unsupported or oversized skill file: ${file.path}`);
    total += file.size;
    if (total > MAX_PACKAGE_BYTES) throw skillError('Skill package exceeds 16 MB');
  }
  const files = {};
  await mapLimited(tree, async (file) => {
    const bytes = await githubFile(entry.info, file.path, signal);
    if (bytes.length !== file.size) throw skillError('GitHub file size mismatch');
    const expectedHash = digest(bytes);
    if (file.path.endsWith('SKILL.md') && file.path.slice(0, -9) === candidate.path && expectedHash !== candidate.hash) throw skillError('Skill source changed during download');
    files[safePackagePath(file.path.slice(prefix.length))] = { base64: bytes.toString('base64'), executable: file.mode === '100755' };
  });
  let extra;
  if (files['agents/openai.yaml']) {
    try { extra = parseDocument(Buffer.from(files['agents/openai.yaml'].base64, 'base64').toString('utf8')).toJS({ maxAliasCount: 0 }); } catch { /* Metadata never grants permissions. */ }
  }
  const parsed = parseSkillDocument(candidate.content, extra);
  // Stable ordering makes package checksums independent of HTTP completion order.
  const ordered = Object.fromEntries(Object.keys(files).sort().map((key) => [key, files[key]]));
  return { ...parsed, files: ordered, hash: digest(JSON.stringify(ordered)), fileCount: tree.length, bytes: total };
}
