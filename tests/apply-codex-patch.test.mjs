import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-codex-patch-'));
process.env.Z_AGENT_DATA_DIR = path.join(runtimeRoot, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(runtimeRoot, 'workspaces');
// Deliberately no Z_AGENT_ALLOW_UNISOLATED_SHELL: this patch format must not need a shell sandbox.
const { executeTool } = await import('../server/native/tools.mjs');
const { commitCodexPlan, executeCodexPatch, planCodexPatch } = await import('../server/native/tools/apply-codex-patch.mjs');
const { MAX_READ_BYTES } = await import('../server/native/tools/filesystem.mjs');
test.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));

const wrap = (body) => `*** Begin Patch\n${body}\n*** End Patch`;

function workspace(t, files = {}) {
  const base = fs.mkdtempSync(path.join(runtimeRoot, 'case-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'workspace');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE\n');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return { root, outside };
}

function snapshot(dir, base = dir, out = {}) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);
    if (entry.isDirectory()) {
      out[`${rel}/`] = 'dir';
      snapshot(full, base, out);
    } else out[rel] = `${fs.statSync(full).mode & 0o777}:${fs.readFileSync(full).toString('latin1')}`;
  }
  return out;
}

const read = (root, name) => fs.readFileSync(path.join(root, name), 'utf8');

test('one patch adds, updates, moves and deletes files and says what it did', (t) => {
  const { root } = workspace(t, {
    'src/a.js': 'const a = 1;\nconst b = 2;\nconst c = 3;\n',
    'old.txt': 'x\ny\n',
    'run.sh': '#!/bin/sh\necho hi\n',
  });
  fs.chmodSync(path.join(root, 'run.sh'), 0o755);
  const result = executeCodexPatch(
    root,
    wrap(
      [
        '*** Add File: new/dir/file.txt',
        '+hello',
        '+world',
        '*** Update File: src/a.js',
        '@@',
        ' const a = 1;',
        '-const b = 2;',
        '+const b = 20;',
        ' const c = 3;',
        '*** Update File: run.sh',
        '*** Move to: bin/run.sh',
        '@@',
        ' #!/bin/sh',
        '-echo hi',
        '+echo hello',
        '*** Delete File: old.txt',
      ].join('\n'),
    ),
  );
  assert.equal(read(root, 'new/dir/file.txt'), 'hello\nworld\n');
  assert.equal(read(root, 'src/a.js'), 'const a = 1;\nconst b = 20;\nconst c = 3;\n');
  assert.equal(read(root, 'bin/run.sh'), '#!/bin/sh\necho hello\n');
  assert.equal(fs.statSync(path.join(root, 'bin/run.sh')).mode & 0o777, 0o755, 'a moved file keeps its permissions');
  assert.equal(fs.existsSync(path.join(root, 'run.sh')), false);
  assert.equal(fs.existsSync(path.join(root, 'old.txt')), false);

  assert.match(result.output, /^Patch applied: 4 files \(\+4 -4\)\./);
  assert.match(result.output, /^A new\/dir\/file\.txt \(\+2\)$/m);
  assert.match(result.output, /^M src\/a\.js \(\+1 -1, line 2\)$/m);
  assert.match(result.output, /^R run\.sh -> bin\/run\.sh \(\+1 -1, line 2\)$/m);
  assert.match(result.output, /^D old\.txt \(-2\)$/m);
  assert.doesNotMatch(result.output, /const b = 20/, 'file contents are not echoed');
  assert.equal(result.title, '4 files');
  assert.deepEqual(result.mutatedPaths, ['new/dir/file.txt', 'src/a.js', 'bin/run.sh', 'run.sh', 'old.txt'], 'deleted paths come last');
  assert.equal(result.metadata.patchFormat, 'codex');
  assert.deepEqual(
    result.metadata.files.map((file) => file.kind),
    ['A', 'M', 'R', 'D'],
  );
});

test('a failing hunk leaves every file as it was, including files the patch would have created', (t) => {
  const { root } = workspace(t, { 'a.txt': 'one\ntwo\n', 'b.txt': 'keep\n' });
  const before = snapshot(root);
  const patch = wrap(
    '*** Add File: made/deep/c.txt\n+c\n*** Update File: a.txt\n@@\n one\n-two\n+TWO\n*** Update File: b.txt\n@@\n-missing\n+x',
  );
  assert.throws(() => executeCodexPatch(root, patch), /Could not find the expected lines of change 1 in b\.txt/);
  assert.deepEqual(snapshot(root), before);
});

test('an invalid patch changes nothing', async (t) => {
  const { root } = workspace(t, { 'a.txt': 'one\n' });
  const before = snapshot(root);
  const ctx = { workspace: root, signal: new AbortController().signal };
  await assert.rejects(
    () => executeTool('apply_patch', { patch: '*** Begin Patch\n*** Add File: x.txt\n+x\n' }, ctx),
    /must end with '\*\*\* End Patch'/,
  );
  await assert.rejects(
    () => executeTool('apply_patch', { patch: wrap('*** Add File: x.txt\n+x\nstray') }, ctx),
    /line 4: every line of an added file/,
  );
  assert.deepEqual(snapshot(root), before);
});

test('Add File never overwrites; Update, Delete and Move need what they refer to', (t) => {
  const { root } = workspace(t, { 'a.txt': 'one\n', 'b.txt': 'two\n' });
  fs.mkdirSync(path.join(root, 'dir'));
  const before = snapshot(root);
  const cases = [
    ['*** Add File: a.txt\n+new', /Cannot add a\.txt: the file already exists.*Update File: a\.txt/],
    ['*** Update File: nope.txt\n@@\n-a\n+b', /Cannot update nope\.txt: there is no such file.*Add File/],
    ['*** Delete File: nope.txt', /Cannot delete nope\.txt: there is no such file/],
    ['*** Update File: a.txt\n*** Move to: b.txt\n@@\n-one\n+uno', /Cannot move a\.txt to b\.txt: the destination already exists/],
    ['*** Delete File: dir', /not a file/i],
    ['*** Add File: dir\n+x', /not a file/i],
    ['*** Add File: a.txt/inside.txt\n+x', /a\.txt\/inside\.txt: a parent of this path is a file/],
  ];
  for (const [body, pattern] of cases) assert.throws(() => executeCodexPatch(root, wrap(body)), pattern, body);
  assert.deepEqual(snapshot(root), before);
});

test('hunks for the same file see each other; add then update, delete then add and ./ spellings work', (t) => {
  const { root } = workspace(t, { 'a.txt': 'one\ntwo\nthree\n', 'r.txt': 'old\n' });
  executeCodexPatch(
    root,
    wrap(
      [
        '*** Update File: a.txt',
        '@@',
        ' one',
        '-two',
        '+2',
        '*** Update File: ./a.txt',
        '@@',
        ' 2',
        '-three',
        '+3',
        '*** Add File: n.txt',
        '+first',
        '*** Update File: n.txt',
        '@@',
        '-first',
        '+second',
        '*** Delete File: r.txt',
        '*** Add File: r.txt',
        '+replaced',
      ].join('\n'),
    ),
  );
  assert.equal(read(root, 'a.txt'), 'one\n2\n3\n');
  assert.equal(read(root, 'n.txt'), 'second\n');
  assert.equal(read(root, 'r.txt'), 'replaced\n');
});

test('an update with only a move renames byte for byte; a file created and deleted in one patch leaves nothing', (t) => {
  const binary = Buffer.from([0, 1, 2, 255, 254, 0]);
  const { root } = workspace(t);
  fs.writeFileSync(path.join(root, 'blob.bin'), binary);
  const result = executeCodexPatch(
    root,
    wrap('*** Update File: blob.bin\n*** Move to: moved/blob.bin\n*** Add File: tmp.txt\n+x\n*** Delete File: tmp.txt'),
  );
  assert.deepEqual(fs.readFileSync(path.join(root, 'moved/blob.bin')), binary);
  assert.equal(fs.existsSync(path.join(root, 'blob.bin')), false);
  assert.equal(fs.existsSync(path.join(root, 'tmp.txt')), false);
  assert.match(result.output, /^R blob\.bin -> moved\/blob\.bin \(renamed\)$/m);
  assert.deepEqual(result.mutatedPaths, ['moved/blob.bin', 'blob.bin']);
});

test('line endings, BOM and the missing final newline survive a patch', (t) => {
  const { root } = workspace(t, { 'crlf.txt': '\uFEFFa\r\nb\r\nc\r\n', 'bare.txt': 'x\ny' });
  executeCodexPatch(root, wrap('*** Update File: crlf.txt\n@@\n a\n-b\n+B1\n+B2\n c\n*** Update File: bare.txt\n@@\n-x\n+X\n y'));
  assert.equal(read(root, 'crlf.txt'), '\uFEFFa\r\nB1\r\nB2\r\nc\r\n');
  assert.equal(read(root, 'bare.txt'), 'X\ny');
});

test('files that are not editable text are refused', (t) => {
  const { root } = workspace(t);
  fs.writeFileSync(path.join(root, 'bin.dat'), Buffer.from([0x61, 0, 0x62]));
  fs.writeFileSync(path.join(root, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
  fs.writeFileSync(path.join(root, 'big.txt'), 'x'.repeat(MAX_READ_BYTES + 1));
  const before = snapshot(root);
  assert.throws(() => executeCodexPatch(root, wrap('*** Update File: bin.dat\n@@\n-a\n+c')), /Binary file bin\.dat/);
  assert.throws(() => executeCodexPatch(root, wrap('*** Update File: latin1.txt\n@@\n-caf\n+tea')), /latin1\.txt is not valid UTF-8/);
  assert.throws(() => executeCodexPatch(root, wrap('*** Update File: big.txt\n@@\n-x\n+y')), /big\.txt is too large for apply_patch/);
  assert.deepEqual(snapshot(root), before);
});

test('paths outside the workspace are refused before anything is touched', (t) => {
  const { root, outside } = workspace(t, { 'a.txt': 'one\n' });
  const before = snapshot(root);
  const escapes = [
    '*** Add File: ../escape.txt\n+x',
    '*** Add File: sub/../../escape.txt\n+x',
    `*** Add File: ${path.join(outside, 'abs.txt')}\n+x`,
    '*** Add File: /etc/z-agent-test\n+x',
    `*** Update File: ../outside/secret.txt\n@@\n-OUTSIDE\n+pwned`,
    '*** Delete File: ../outside/secret.txt',
    '*** Update File: a.txt\n*** Move to: ../moved.txt\n@@\n-one\n+two',
    '*** Add File: C:\\temp\\x.txt\n+x',
  ];
  for (const body of escapes)
    assert.throws(() => executeCodexPatch(root, wrap(`*** Add File: fine.txt\n+ok\n${body}`)), /Unsafe patch path/, body);
  assert.deepEqual(snapshot(root), before);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'OUTSIDE\n');
  assert.equal(fs.existsSync(path.join(outside, 'abs.txt')), false);
});

test('symlinks cannot be used to reach files outside the workspace', (t) => {
  const { root, outside } = workspace(t, { 'a.txt': 'one\n' });
  fs.symlinkSync(outside, path.join(root, 'link-dir'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  const patches = [
    '*** Update File: link.txt\n@@\n-OUTSIDE\n+pwned',
    '*** Delete File: link.txt',
    '*** Delete File: link-dir/secret.txt',
    '*** Add File: link-dir/new.txt\n+pwned',
    '*** Update File: a.txt\n*** Move to: link-dir/moved.txt\n@@\n-one\n+two',
  ];
  for (const body of patches) assert.throws(() => executeCodexPatch(root, wrap(body)), /Symlink|symbolic/i, body);
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'OUTSIDE\n');
  assert.deepEqual(fs.readdirSync(outside), ['secret.txt']);
  assert.equal(read(root, 'a.txt'), 'one\n');
  assert.equal(fs.lstatSync(path.join(root, 'link.txt')).isSymbolicLink(), true);
});

test('a symlink swapped in after the path check is still not followed', (t) => {
  const { root, outside } = workspace(t, { 'a.txt': 'one\n' });
  fs.symlinkSync(outside, path.join(root, 'link-dir'));
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (target, ...rest) => {
    const stat = lstat(target, ...rest);
    return stat?.isSymbolicLink?.()
      ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { isSymbolicLink: () => false })
      : stat;
  });
  for (const body of [
    '*** Update File: link.txt\n@@\n-OUTSIDE\n+pwned',
    '*** Delete File: link.txt',
    '*** Add File: link-dir/new.txt\n+pwned',
  ]) {
    assert.throws(() => executeCodexPatch(root, wrap(body)), undefined, body);
  }
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'OUTSIDE\n');
  assert.deepEqual(fs.readdirSync(outside), ['secret.txt']);
});

test('a write that fails half-way is rolled back, files that were created and files that were rewritten', (t) => {
  const { root } = workspace(t, { 'a.txt': 'one\ntwo\n', 'b.txt': 'keep\n' });
  const before = snapshot(root);
  const write = fs.writeSync;
  t.mock.method(fs, 'writeSync', (fd, data, ...rest) => {
    if (Buffer.isBuffer(data) && data.includes('BOOM')) throw Object.assign(new Error('No space left on device'), { code: 'ENOSPC' });
    return write(fd, data, ...rest);
  });
  const patch = wrap(
    '*** Add File: made/deep/c.txt\n+c\n*** Update File: b.txt\n@@\n-keep\n+kept\n*** Update File: a.txt\n@@\n one\n-two\n+BOOM',
  );
  assert.throws(
    () => executeCodexPatch(root, patch),
    /Patch failed: No space left on device\. The patch was rolled back: no file was changed\./,
  );
  assert.deepEqual(snapshot(root), before, 'nothing created, nothing rewritten, no leftover directories');
});

test('a failed delete restores the files the patch had already rewritten', (t) => {
  const { root } = workspace(t, { 'a.txt': 'one\n', 'gone.txt': 'bye\n' });
  const before = snapshot(root);
  const unlink = fs.unlinkSync;
  t.mock.method(fs, 'unlinkSync', (target, ...rest) => {
    if (String(target).endsWith('/gone.txt')) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
    return unlink(target, ...rest);
  });
  assert.throws(
    () => executeCodexPatch(root, wrap('*** Update File: a.txt\n@@\n-one\n+1\n*** Delete File: gone.txt')),
    /Patch failed: EBUSY.*rolled back/,
  );
  assert.deepEqual(snapshot(root), before);
});

test('a file that changes between reading and writing is not overwritten', (t) => {
  const { root } = workspace(t, { 'a.txt': 'one\n', 'b.txt': 'two\n', 'c.txt': 'three\n' });
  const plan = planCodexPatch(
    root,
    wrap(
      '*** Update File: a.txt\n@@\n-one\n+1\n*** Add File: made.txt\n+x\n*** Delete File: b.txt\n*** Update File: c.txt\n@@\n-three\n+3',
    ),
  );
  fs.writeFileSync(path.join(root, 'a.txt'), 'edited by someone else\n');
  assert.throws(() => commitCodexPlan(root, plan), /a\.txt changed while the patch was being applied/);
  assert.equal(read(root, 'a.txt'), 'edited by someone else\n');
  assert.equal(fs.existsSync(path.join(root, 'made.txt')), false, 'the file created before the conflict was removed again');
  assert.equal(read(root, 'b.txt'), 'two\n');
  assert.equal(read(root, 'c.txt'), 'three\n');

  const second = planCodexPatch(root, wrap('*** Delete File: b.txt\n*** Add File: made.txt\n+x'));
  fs.writeFileSync(path.join(root, 'b.txt'), 'two, edited\n');
  assert.throws(() => commitCodexPlan(root, second), /b\.txt changed while the patch was being applied/);
  assert.equal(read(root, 'b.txt'), 'two, edited\n');

  const third = planCodexPatch(root, wrap('*** Add File: late.txt\n+mine'));
  fs.writeFileSync(path.join(root, 'late.txt'), 'theirs\n');
  assert.throws(() => commitCodexPlan(root, third), /late\.txt changed while the patch was being applied/);
  assert.equal(read(root, 'late.txt'), 'theirs\n');
});

test('hunks that change nothing are called out instead of reported as edits', (t) => {
  const { root } = workspace(t, { 'a.txt': 'one\ntwo\n' });
  const result = executeCodexPatch(root, wrap('*** Update File: a.txt\n@@\n one\n two'));
  assert.match(result.output, /^M a\.txt \(no changes\)$/m);
  assert.match(result.output, /Note: the hunks for a\.txt left the file as it was\./);
  assert.deepEqual(result.mutatedPaths, []);
  assert.equal(read(root, 'a.txt'), 'one\ntwo\n');
});

test('a hunk with only added lines under an @@ line is flagged because it was appended', (t) => {
  const { root } = workspace(t, { 'a.txt': 'head\nbody\n' });
  const result = executeCodexPatch(root, wrap('*** Update File: a.txt\n@@ head\n+inserted'));
  assert.equal(read(root, 'a.txt'), 'head\nbody\ninserted\n');
  assert.match(result.output, /Note: Change 1 has only added lines, so it was appended at the end of a\.txt/);
});

test('apply_patch takes "*** Begin Patch" without git, a shell sandbox or a session', async (t) => {
  const { root } = workspace(t, { 'a.txt': 'hello\n' });
  const ctx = { workspace: root, signal: new AbortController().signal };
  const result = await executeTool(
    'apply_patch',
    { patch: `apply_patch <<'EOF'\n${wrap('*** Update File: a.txt\n@@\n-hello\n+world\n*** Add File: b/c.txt\n+new')}\nEOF` },
    ctx,
  );
  assert.equal(read(root, 'a.txt'), 'world\n');
  assert.equal(read(root, 'b/c.txt'), 'new\n');
  assert.deepEqual(result.mutatedPaths, ['a.txt', 'b/c.txt'], 'exact paths, not "."');
  assert.match(result.output, /Patch applied: 2 files/);

  fs.mkdirSync(process.env.Z_AGENT_WORKSPACES_DIR, { recursive: true });
  const sessionRoot = fs.mkdtempSync(path.join(process.env.Z_AGENT_WORKSPACES_DIR, 'codex-patch-'));
  t.after(() => fs.rmSync(sessionRoot, { recursive: true, force: true }));
  fs.writeFileSync(path.join(sessionRoot, 'a.txt'), 'hello\n');
  const withSession = await executeTool(
    'apply_patch',
    { patch: wrap('*** Update File: a.txt\n@@\n-hello\n+session') },
    { workspace: sessionRoot, sessionId: 'ses_codexpatch', signal: new AbortController().signal },
  );
  assert.equal(read(sessionRoot, 'a.txt'), 'session\n');
  assert.deepEqual(withSession.mutatedPaths, ['a.txt']);
});

test('a patch that leaves a source file unparseable is reported right away', async (t) => {
  const { root } = workspace(t, { 'data.json': '{"a": 1}\n' });
  const ctx = { workspace: root, signal: new AbortController().signal };
  const result = await executeTool('apply_patch', { patch: wrap('*** Update File: data.json\n@@\n-{"a": 1}\n+{"a": ') }, ctx);
  assert.match(result.output, /Syntax check failed after this change/);
  assert.match(result.output, /data\.json: invalid JSON/);
  assert.equal(result.metadata.syntaxError, true);
});
