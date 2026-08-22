import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRepoMap, formatRepoMap } from '../server/native/repo-intelligence.mjs';
import { getSubagentProfile, normalizeSubagentKind, subagentKinds } from '../server/native/subagents.mjs';
import { executeTool, requiresPermission, TOOL_DEFINITIONS } from '../server/native/tools.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-repomap-'));
  fs.mkdirSync(path.join(root, 'src', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'feature'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'noise'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture-app',
    type: 'module',
    packageManager: 'npm@10',
    scripts: { test: 'node --test', build: 'tsc -b' },
    dependencies: { react: '^19.0.0' },
    devDependencies: { typescript: '^7.0.0' },
  }, null, 2));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}\n');
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), "import { helper } from './lib/helper';\nexport function start() { return helper(); }\n");
  fs.writeFileSync(path.join(root, 'src', 'feature', 'run.ts'), "import { helper } from '../lib/helper';\nexport const run = () => helper();\n");
  fs.writeFileSync(path.join(root, 'src', 'lib', 'helper.ts'), 'export function helper() { return 1; }\n');
  fs.writeFileSync(path.join(root, 'tests', 'helper.test.ts'), "import { helper } from '../src/lib/helper';\nvoid helper();\n");
  fs.writeFileSync(path.join(root, 'node_modules', 'noise', 'index.js'), 'export const shouldNotAppear = true;\n');
  return root;
}

test('repo map extracts manifests, scripts, entrypoints, import hubs, symbols and tests while ignoring vendor trees', () => {
  const root = fixture();
  const map = buildRepoMap(root, root, { maxFiles: 500, maxSymbolsPerFile: 8 });

  assert.equal(map.truncated, false);
  assert.equal(map.package?.name, 'fixture-app');
  assert.equal(map.package?.scripts?.test, 'node --test');
  assert.ok(map.manifests.includes('package.json'));
  assert.ok(map.configs.includes('tsconfig.json'));
  assert.ok(map.languages.some((row) => row.language === 'TypeScript' && row.files === 4));
  assert.ok(map.entrypoints.some((row) => row.path === 'src/index.ts'));
  assert.ok(map.importHubs.some((row) => row.path === 'src/lib/helper.ts' && row.inboundImports === 3));
  assert.ok(map.symbolFiles.some((row) => row.path === 'src/lib/helper.ts' && row.symbols.some((symbol) => symbol.name === 'helper')));
  assert.ok(map.tests.includes('tests/helper.test.ts'));
  assert.equal(formatRepoMap(map).includes('node_modules/noise'), false);
});

test('repo_map tool is read-only and returns bounded structured metadata', async () => {
  const root = fixture();
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === 'repo_map');
  assert.ok(definition);
  assert.equal(requiresPermission('repo_map'), false);

  const result = await executeTool('repo_map', { maxFiles: 500, maxSymbolsPerFile: 5 }, { workspace: root });
  assert.match(result.output, /Repository map/);
  assert.match(result.output, /fixture-app/);
  assert.match(result.output, /src\/lib\/helper\.ts/);
  assert.equal(result.metadata?.repoMap?.truncated, false);
  assert.ok(result.metadata?.repoMap?.fileCount >= 6);
});

test('specialized subagent profiles are explicit, default safely to explore, and only implement may write', () => {
  // Состав реестра фиксируем явно (чтобы случайное удаление профиля было
  // видно), а инвариант read-only ниже выводим из реестра, чтобы любой новый
  // профиль автоматически попадал под проверку, а не ломал тест списком.
  assert.deepEqual(subagentKinds(), ['planner', 'explore', 'debug', 'review', 'security', 'tester', 'implement']);
  assert.equal(normalizeSubagentKind('DEBUG'), 'debug');
  assert.equal(normalizeSubagentKind('unknown'), 'explore');
  assert.equal(normalizeSubagentKind('IMPLEMENT'), 'implement');

  const explore = getSubagentProfile('explore');
  const debug = getSubagentProfile('debug');
  const review = getSubagentProfile('review');
  assert.match(explore.system, /repo_map/);
  assert.match(explore.system, /read-only/i);
  assert.match(debug.system, /root-cause/i);
  assert.match(debug.system, /cannot execute shell commands/i);
  assert.match(review.system, /severity/i);
  assert.match(review.system, /security/i);
  assert.match(getSubagentProfile('planner').system, /architecture plan/i);
  assert.match(getSubagentProfile('security').system, /vulnerabilit/i);
  assert.match(getSubagentProfile('tester').system, /edge cases/i);
  assert.ok(debug.maxSteps >= explore.maxSteps);

  // The read-only guarantee is what makes investigation profiles safe to run
  // speculatively; only the implement profile may mutate the workspace.
  for (const kind of subagentKinds().filter((kind) => kind !== 'implement')) {
    const profile = getSubagentProfile(kind);
    assert.ok(!profile.writes, `${kind} must stay read-only`);
    for (const tool of ['write', 'edit', 'apply_patch', 'bash', 'git', 'run_tests']) {
      assert.ok(!profile.tools.includes(tool), `${kind} must not expose ${tool}`);
    }
  }
  assert.equal(getSubagentProfile('implement').writes, true);
});
