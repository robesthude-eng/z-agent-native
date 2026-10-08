import assert from 'node:assert/strict';
import test from 'node:test';

process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL = '1';
const { createTurnStrategy, isCheckConfigPath, observeTool, strategyGuidance } = await import('../server/native/context.mjs');
const { parseReview } = await import('../server/native/agent/reviewer.mjs');

const edit = (strategy, file) =>
  observeTool(strategy, { name: 'edit', arguments: { path: file } }, { isError: false, metadata: {}, mutatedPaths: [file] });
const check = (strategy, exit) =>
  observeTool(
    strategy,
    { name: 'bash', arguments: { command: 'npm test' } },
    { isError: exit !== 0, metadata: { exit }, mutatedPaths: [] },
  );

test('isCheckConfigPath recognises lint, type, test and CI configuration only', () => {
  for (const file of [
    'biome.json',
    'tsconfig.json',
    'tsconfig.app.json',
    'src/.eslintrc.json',
    'eslint.config.mjs',
    'vitest.config.ts',
    '.github/workflows/ci.yml',
    '.husky/pre-commit',
    'pytest.ini',
    '.pre-commit-config.yaml',
  ]) {
    assert.equal(isCheckConfigPath(file), true, file);
  }
  for (const file of ['package.json', 'src/index.ts', 'README.md', 'src/tsconfig-helper.ts', 'docs/biome.md']) {
    assert.equal(isCheckConfigPath(file), false, file);
  }
});

test('editing check config after a failing check is recorded and surfaced', () => {
  const strategy = createTurnStrategy('Make the tests pass');
  edit(strategy, 'src/a.ts');
  check(strategy, 1);
  assert.equal(strategy.sawFailedVerification, true);
  edit(strategy, 'src/a.ts');
  assert.deepEqual(strategy.checkConfigEdits, []);
  edit(strategy, 'biome.json');
  assert.deepEqual(strategy.checkConfigEdits, ['biome.json']);
  assert.match(strategyGuidance(strategy), /edited check configuration \(biome\.json\)/);
});

test('configuring tooling before any check failed is normal work and is not flagged', () => {
  const strategy = createTurnStrategy('Set up linting');
  edit(strategy, 'biome.json');
  edit(strategy, '.github/workflows/ci.yml');
  assert.deepEqual(strategy.checkConfigEdits, []);
  assert.doesNotMatch(strategyGuidance(strategy), /check configuration/);
});

test('strategies restored without the new fields are normalised', () => {
  const restored = { ...createTurnStrategy('old'), checkConfigEdits: undefined, sawFailedVerification: undefined };
  edit(restored, 'src/a.ts');
  assert.deepEqual(restored.checkConfigEdits, []);
  assert.equal(restored.sawFailedVerification, false);
});

test('reviewer verdict parsing is unchanged by the stricter prompt', () => {
  const review = parseReview(
    '{"verdict":"fix","summary":"x","issues":[{"severity":"blocker","file":"biome.json","line":1,"problem":"loosened lint","fix":"revert"}]}',
  );
  assert.equal(review.verdict, 'fix');
  assert.equal(review.issues.length, 1);
});
