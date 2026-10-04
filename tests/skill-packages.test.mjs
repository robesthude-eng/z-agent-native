import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-packages-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';
const store = await import('../server/native/store.mjs');
const lib = await import('../server/native/skills/library.mjs');
const installer = await import('../server/native/skills/installer.mjs');
const pkg = await import('../server/native/skills/package.mjs');
const { executeSkillTool, memoryPrompt } = await import('../server/native/agent-memory.mjs');
const { handleSkillRoutes } = await import('../server/routes/skills.mjs');
const { Readable } = await import('node:stream');
const owner = 'skill-owner@example.com', other = 'skill-other@example.com';
store.createUser(owner, 'hash'); store.createUser(other, 'hash');
for (const sid of ['ses_skillsA', 'ses_skillsB']) store.createChat(sid, owner, sid);
store.createChat('ses_skillsOther', other, 'Other');
const doc = (name, extra = '') => `---\nname: ${name}\ndescription: >\n  Design good interfaces and test\n  their accessibility.\nlicense: MIT\n${extra}---\n# Workflow\nRead references/guide.md and inspect scripts/check.py.\nRun python3 \${CLAUDE_SKILL_DIR}/scripts/check.py when needed.\n`;
const bundle = zipSync({ 'repo/skills/demo-skill/SKILL.md': strToU8(doc('demo-skill')), 'repo/skills/demo-skill/references/guide.md': strToU8('Reference content'), 'repo/skills/demo-skill/scripts/check.py': strToU8('print("no execution on install")'), 'repo/skills/manual-skill/SKILL.md': strToU8(doc('manual-skill', 'disable-model-invocation: true\n')), 'repo/skills/codex-skill/SKILL.md': strToU8(doc('codex-skill')), 'repo/skills/codex-skill/agents/openai.yaml': strToU8('policy:\n  allow_implicit_invocation: false\n') });
const upload = { filename: 'bundle.zip', contentBase64: Buffer.from(bundle).toString('base64') };
let preview;
test.after(() => { installer.setSkillFetcherForTests(null); fs.rmSync(root, { recursive: true, force: true }); });

test('standard YAML, folded descriptions, invocation policy and compatibility notes', () => {
  assert.equal(pkg.parseSkillDocument(doc('demo-skill')).description, 'Design good interfaces and test their accessibility.');
  assert.equal(pkg.parseSkillDocument(doc('demo-skill', 'disable-model-invocation: true\n')).autoUse, false);
  assert.throws(() => pkg.parseSkillDocument('no frontmatter'), /frontmatter/);
  assert.throws(() => pkg.parseSkillDocument(doc('../escape')), /slug/);
  assert.throws(() => pkg.parseSkillDocument('---\nname: demo\ndescription: &ref hello\nmetadata: *ref\n---\nBody'), /aliases/);
  assert.throws(() => pkg.parseSkillDocument(doc('demo') + 'x'.repeat(96000)), /96 KB/);
  assert.match(pkg.parseSkillDocument(doc('demo', 'hooks: {}\nallowed-tools: Bash\n')).warnings.join(), /does not execute/);
});

test('discovery lists individual skills, installation preserves bundled resources without running them', async () => {
  preview = await installer.discoverSkills(owner, upload);
  assert.equal(preview.candidates.length, 3);
  await assert.rejects(lib.installSkill(owner, { source: preview.source }), /specific skill path/);
  const skill = await lib.installSkill(owner, { source: preview.source, path: 'repo/skills/demo-skill' });
  assert.equal(skill.name, 'demo-skill');
  assert.equal(skill.source.fileCount, 3);
  assert.equal(skill.source.type, 'upload');
  assert.ok(skill.source.hash);
  assert.equal((await lib.installSkill(owner, { source: preview.source, path: 'repo/skills/demo-skill' })).alreadyInstalled, true);
  const loaded = executeSkillTool({ action: 'read', name: skill.name }, { ownerId: owner, sessionId: 'ses_skillsA', workspace: store.workspaceFor('ses_skillsA') });
  assert.match(loaded.output, /Resources copied to/);
  assert.doesNotMatch(loaded.output, /\$\{CLAUDE_SKILL_DIR\}/);
  assert.equal(fs.readFileSync(path.join(store.workspaceFor('ses_skillsA'), loaded.metadata.skill.directory, 'references/guide.md'), 'utf8'), 'Reference content');
  assert.equal(lib.materializeSkill(owner, 'ses_skillsA', store.workspaceFor('ses_skillsA'), skill.name).directory, loaded.metadata.skill.directory, 'reuses a verified copy instead of growing disk on each turn');
});

test('installed package updates require explicit replacement; names and downloads are owner-isolated', async () => {
  await assert.rejects(installer.discoverSkills(other, { source: preview.source }), /expired/);
  assert.equal(store.listSkills(other).length, 0);
  const changed = await installer.discoverSkills(owner, { filename: 'SKILL.md', contentBase64: Buffer.from(doc('demo-skill') + '\nUpdated').toString('base64') });
  await assert.rejects(lib.installSkill(owner, { source: changed.source }), /already exists/);
  assert.equal((await lib.installSkill(owner, { source: changed.source, replace: true })).name, 'demo-skill');
  assert.throws(() => executeSkillTool({ action: 'save', name: 'demo-skill', content: 'overwrite', description: 'overwrite' }, { ownerId: owner }), /cannot be overwritten/);
});

test('manual-only Claude/Codex policies and per-chat auto/manual/off selection are enforced', async () => {
  await lib.installSkill(owner, { source: preview.source, path: 'repo/skills/manual-skill' });
  const codex = await lib.installSkill(owner, { source: preview.source, path: 'repo/skills/codex-skill' });
  assert.equal(codex.autoUse, false);
  assert.equal(lib.availableSkills(owner, 'ses_skillsA').some((s) => s.name === 'manual-skill'), false);
  assert.throws(() => executeSkillTool({ action: 'read', name: 'manual-skill' }, { ownerId: owner, sessionId: 'ses_skillsA' }), /disabled|not available/);
  assert.throws(() => executeSkillTool({ action: 'enable', name: 'manual-skill' }, { ownerId: owner, sessionId: 'ses_skillsA' }), /manual-only/);
  lib.setChatSkillSettings(owner, 'ses_skillsA', { mode: 'manual', selected: ['manual-skill'] });
  assert.deepEqual(lib.availableSkills(owner, 'ses_skillsA').map((s) => s.name), ['manual-skill']);
  assert.deepEqual(lib.availableSkills(owner, 'ses_skillsB').map((s) => s.name), ['demo-skill']);
  assert.match(lib.skillsPrompt(owner, 'ses_skillsA'), /Selected skill manual-skill/);
  lib.setChatSkillSettings(owner, 'ses_skillsA', { mode: 'off' });
  assert.equal(lib.availableSkills(owner, 'ses_skillsA').length, 0);
  assert.throws(() => executeSkillTool({ action: 'install', source: preview.source }, { ownerId: owner, sessionId: 'ses_skillsA' }), /disabled/);
});

test('global disable, chat exclusions, installation switch and owner checks', async () => {
  lib.setChatSkillSettings(owner, 'ses_skillsA', { mode: 'auto', selected: [], excluded: ['demo-skill'], allowInstall: false });
  assert.equal(lib.availableSkills(owner, 'ses_skillsA').length, 0);
  assert.throws(() => lib.chatSkillSettings(other, 'ses_skillsA'), /Session not found/);
  assert.throws(() => lib.setChatSkillSettings(owner, 'ses_skillsA', { selected: ['missing'] }), /Unknown/);
  assert.throws(() => lib.configureSkill(other, 'demo-skill', { enabled: false }), /not found/);
  lib.configureSkill(owner, 'demo-skill', { enabled: false });
  assert.equal(lib.availableSkills(owner, 'ses_skillsB').length, 0);
  lib.configureSkill(owner, 'demo-skill', { enabled: true });
  assert.throws(() => executeSkillTool({ action: 'discover', source: 'https://example.com' }, { ownerId: owner, sessionId: 'ses_skillsA' }), /disabled/);
  assert.match(memoryPrompt(owner, null, { includeSkills: false }), /Long-term memory/);
});

test('unsafe archive paths, ZIP symlinks, file size limits and workspace symlinks fail closed', () => {
  for (const name of ['../evil', '/evil', 'a/../../evil', 'C:/evil', 'a\\evil']) assert.throws(() => pkg.safePackagePath(name), /Unsafe/);
  const bad = zipSync({ '../evil/SKILL.md': strToU8(doc('evil')) });
  assert.throws(() => pkg.archiveCandidates(bad), /Unsafe/);
  const big = zipSync({ 's/SKILL.md': strToU8(doc('large')), 's/big': new Uint8Array(pkg.MAX_FILE_BYTES + 1) });
  assert.throws(() => pkg.packageFromArchive(big, 's'), /oversized/);
  const link = Buffer.from(zipSync({ 's/SKILL.md': strToU8(doc('link-skill')), 's/link': strToU8('/etc/passwd') }));
  for (let i = 0; i < link.length - 46; i++) if (link.readUInt32LE(i) === 0x02014b50 && link.subarray(i + 46, i + 46 + link.readUInt16LE(i + 28)).toString() === 's/link') link.writeUInt32LE((0o120777 << 16) >>> 0, i + 38);
  assert.throws(() => pkg.packageFromArchive(link, 's'), /Unsupported/);
  const ws = store.workspaceFor('ses_skillsB');
  fs.symlinkSync(root, path.join(ws, '.agent-skills'));
  assert.throws(() => lib.materializeSkill(owner, 'ses_skillsB', ws, 'demo-skill'), /Symlink/);
  fs.unlinkSync(path.join(ws, '.agent-skills'));
});

test('article discovery returns source links without executing or installing anything', async () => {
  installer.setSkillFetcherForTests(async () => new Response('<html><a href="https://github.com/example/skills">Skills</a><a href="http://127.0.0.1">not a source</a></html>', { headers: { 'content-type': 'text/html' } }));
  const result = await installer.discoverSkills(owner, { source: 'https://example.com/article' });
  assert.deepEqual(result.links, ['https://github.com/example/skills']);
  assert.equal(result.candidates.length, 0);
  await assert.rejects(lib.installSkill(owner, { source: 'https://example.com/article' }), /article/);
  installer.setSkillFetcherForTests(null);
});

test('GitHub uses pinned selective file downloads, not the entire repository', async () => {
  const sha = 'a'.repeat(40), treeSha = 'b'.repeat(40);
  const content = doc('github-test');
  const calls = [];
  installer.setSkillFetcherForTests(async (url) => {
    calls.push(url);
    if (url.includes('/commits/')) return Response.json({ sha, commit: { tree: { sha: treeSha } } });
    if (url.includes('/git/trees/')) return Response.json({ truncated: false, tree: [
      { path: 'skills/github-test/SKILL.md', mode: '100644', type: 'blob', size: Buffer.byteLength(content) },
      { path: 'skills/github-test/references/guide.md', mode: '100644', type: 'blob', size: 5 },
      { path: 'unrelated-big-video.mp4', mode: '100644', type: 'blob', size: 999999999 },
    ] });
    if (url.endsWith('SKILL.md')) return new Response(content);
    if (url.endsWith('guide.md')) return new Response('guide');
    throw new Error('Unexpected download: ' + url);
  });
  const discovered = await installer.discoverSkills(owner, { source: 'https://github.com/example/skills' });
  const installed = await lib.installSkill(owner, { source: discovered.source, path: 'skills/github-test' });
  assert.equal(installed.name, 'github-test');
  assert.equal(installed.source.revision, sha);
  assert.equal(installed.source.fileCount, 2);
  assert.equal(calls.some((u) => u.includes('codeload') || u.includes('unrelated-big-video')), false);
  assert.ok(calls.filter((u) => u.includes('raw.githubusercontent.com')).every((u) => u.includes(sha)));
  installer.setSkillFetcherForTests(null);
});

test('public source fetch rejects private hosts and insecure URLs', async () => {
  await assert.rejects(installer.discoverSkills(owner, { source: 'http://example.com/SKILL.md' }), /HTTPS/);
  await assert.rejects(installer.discoverSkills(owner, { source: 'https://127.0.0.1/SKILL.md' }), /private|public|local|loopback|запрещ/i);
});

test('skill HTTP routes are owner-scoped and validate patch input', async () => {
  const request = (method, body) => { const req = Readable.from(body == null ? [] : [JSON.stringify(body)]); req.method = method; req.headers = {}; return req; };
  const response = () => ({ setHeader() {}, writeHead(code) { this.status = code; }, end(text) { this.body = text; } });
  const res = response();
  assert.equal(await handleSkillRoutes(request('GET'), res, '/api/session/ses_skillsB/skills', owner), true);
  assert.equal(JSON.parse(res.body).mode, 'auto');
  await assert.rejects(handleSkillRoutes(request('GET'), response(), '/api/session/ses_skillsB/skills', other), /Session not found/);
  assert.equal(await handleSkillRoutes(request('GET'), response(), '/api/unrelated', owner), false);
});

test('the real agent loop can discover, self-install and read a skill, and reuse it in a new chat', async () => {
  const agent = await import('../server/native/agent.mjs');
  const providers = await import('../server/native/providers.mjs');
  const configs = await import('../server/native/provider-configs.mjs');
  configs.upsertProviderConfig(owner, { id: 'channel_skills', name: 'Skills test', protocol: 'openai', baseURL: 'https://1.1.1.1/v1', enabled: true });
  store.setProviderKey(owner, 'channel_skills', 'dummy-test-key');
  agent.resetAgentStateForTests();
  const sid = 'ses_skillsAgent'; store.createChat(sid, owner, 'Self-install');
  let calls = 0, previewId = '';
  const content = doc('agent-installed');
  installer.setSkillFetcherForTests(async () => new Response(content, { headers: { 'content-type': 'text/markdown' } }));
  const response = (delta, finish = 'stop') => new Response([{ choices: [{ delta }] }, { choices: [{ delta: {}, finish_reason: finish }] }, '[DONE]'].map((x) => `data: ${typeof x === 'string' ? x : JSON.stringify(x)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  const call = (action, args) => response({ tool_calls: [{ index: 0, id: `skill${calls}`, function: { name: 'skill', arguments: JSON.stringify({ action, ...args }) } }] }, 'tool_calls');
  providers.setProviderTransportForTests(async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    if (calls === 1) { assert.match(String(body.messages[0]?.content), /Agent Skills/); return call('discover', { source: 'https://example.com/SKILL.md' }); }
    if (calls === 2) { const output = JSON.parse(body.messages.at(-1).content); previewId = output.source; return call('install', { source: previewId, path: '' }); }
    if (calls === 3) return call('read', { name: 'agent-installed' });
    assert.match(String(body.messages.at(-1).content), /Resources copied to/);
    return response({ content: 'Навык agent-installed установлен и изучен. Проверка инструкций завершена.' });
  });
  try {
    const answer = await agent.runTurn({ sessionId: sid, ownerId: owner, parts: [{ type: 'text', text: 'Изучи и установи скилл https://example.com/SKILL.md для нашей задачи.' }], model: { providerID: 'channel_skills', modelID: 'm' }, system: '' });
    assert.equal(calls, 4);
    assert.equal(answer.parts.filter((p) => p.type === 'tool' && p.tool === 'skill' && p.state.status === 'completed').length, 3);
    assert.match(lib.skillsPrompt(owner, 'ses_skillsB'), /agent-installed/);
    assert.equal(fs.readdirSync(path.join(store.workspaceFor(sid), '.agent-skills')).length, 1);
  } finally { providers.setProviderTransportForTests(null); installer.setSkillFetcherForTests(null); agent.resetAgentStateForTests(); }
});
