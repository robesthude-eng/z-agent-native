import assert from 'node:assert/strict';
import test from 'node:test';
import { assertHooksNotBypassed, hookBypassReason } from '../server/native/hook-bypass.mjs';

test('git hook bypasses are detected', () => {
  for (const command of [
    'git commit --no-verify -m "x"',
    'git commit -m "x" --no-verify',
    'git push --no-verify origin main',
    'git commit -nm "wip"',
    'git commit -n -m wip',
    'npm test && git commit --no-verify -m done',
    'git -c core.hooksPath=/dev/null commit -m x',
    'git -c "core.hooksPath=/dev/null" commit -m x',
    'git config core.hooksPath /tmp/none',
    'HUSKY=0 git commit -m x',
    'rm .git/hooks/pre-commit',
  ]) {
    assert.ok(hookBypassReason(command), `should block: ${command}`);
  }
});

test('ordinary git usage and mentions inside messages are not blocked', () => {
  for (const command of [
    'git commit -m "fix"',
    'git commit -am "docs: explain --no-verify is forbidden"',
    "git commit -m 'never use git commit -n'",
    'git push -n origin main',
    'git push --dry-run',
    'git config --get core.hooksPath',
    'git status && git diff',
    'echo "--no-verify"',
    'npm run lint',
  ]) {
    assert.equal(hookBypassReason(command), null, `should allow: ${command}`);
  }
});

test('assertHooksNotBypassed throws a 403 and honours the operator escape hatch', () => {
  assert.throws(
    () => assertHooksNotBypassed('git commit --no-verify -m x', {}),
    (error) => {
      assert.equal(error.statusCode, 403);
      assert.equal(error.code, 'SHELL_HOOK_BYPASS_BLOCKED');
      assert.match(error.message, /fix what the hook reports/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertHooksNotBypassed('git commit --no-verify -m x', { Z_AGENT_ALLOW_HOOK_BYPASS: '1' }));
  assert.doesNotThrow(() => assertHooksNotBypassed('git commit -m x', {}));
});
