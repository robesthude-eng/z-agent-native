// Git hooks (pre-commit, pre-push, commit-msg) are the project's own quality
// gate. An agent that hits a failing hook sometimes "solves" it by skipping the
// hook, which hides the failure instead of fixing it. This guard refuses the
// common bypasses so the agent has to fix the cause. It is behaviour hygiene,
// not a security boundary, and applies in every shell network policy.
//
// Idea borrowed from the ECC project's block-no-verify hook (MIT); the code here
// is an independent implementation. Escape hatch: Z_AGENT_ALLOW_HOOK_BYPASS=1.

function stripQuoted(text) {
  return String(text || '')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function segmentsOf(text) {
  return text
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Returns a short reason when the command skips or disables git hooks, else null. */
export function hookBypassReason(command) {
  const raw = String(command || '');
  if (!/\bgit\b|HUSKY/i.test(raw)) return null;

  // core.hooksPath override: look at the raw text, the value is often quoted.
  if (/\bgit\b[^\n;&|]*?\s-c\s*["']?core\.hookspath\b/i.test(raw)) return 'overrides core.hooksPath';
  if (/\bgit\s+config\b(?![^\n;&|]*--(?:get|list|unset|show-origin)\b)[^\n;&|]*\bcore\.hookspath\b/i.test(raw)) {
    return 'changes core.hooksPath';
  }

  for (const segment of segmentsOf(stripQuoted(raw))) {
    if (/(?:^|\s)HUSKY=0\b|(?:^|\s)HUSKY_SKIP_HOOKS=\S+/.test(segment)) return 'disables Husky hooks';
    if (/\b(?:rm|mv|chmod|truncate)\b[^|;&]*\.git\/hooks\b/.test(segment)) return 'tampers with .git/hooks';
    if (!/(?:^|\s)git\b/.test(segment)) continue;
    if (/\s--no-verify\b/.test(segment)) return 'uses --no-verify';
    // `git commit -n` is the short form of --no-verify (for push -n means dry-run).
    if (/(?:^|\s)git\b[^|;&]*?\bcommit\b[^|;&]*?\s-[A-Za-z]*n[A-Za-z]*(?:\s|$)/.test(segment)) {
      return 'uses git commit -n (--no-verify)';
    }
  }
  return null;
}

export function hookBypassAllowed(env = process.env) {
  return String(env.Z_AGENT_ALLOW_HOOK_BYPASS || '') === '1';
}

export function assertHooksNotBypassed(command, env = process.env) {
  if (hookBypassAllowed(env)) return;
  const reason = hookBypassReason(command);
  if (!reason) return;
  throw Object.assign(
    new Error(
      `Blocked: this command ${reason}. Git hooks are the project's quality gate; fix what the hook reports instead of skipping it. ` +
        'If the user explicitly wants hooks skipped, an operator can set Z_AGENT_ALLOW_HOOK_BYPASS=1.',
    ),
    { statusCode: 403, code: 'SHELL_HOOK_BYPASS_BLOCKED' },
  );
}
