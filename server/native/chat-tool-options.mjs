/**
 * Per-request tool options chosen by the user.
 *
 * - `webSearch`: allow the `websearch` tool (default on).
 * - `bashFirst`: shell-centred toolset (default off). The agent keeps `bash`,
 *   the editing tools (`write`, `edit`, `apply_patch` - diff cards, exact change
 *   tracking), planning, questions, web, git/environment helpers (they exist
 *   because direct network access from `bash` is blocked) and media tools. The
 *   read-only exploration and verification helpers are replaced by plain shell
 *   commands, which shortens every request and matches how models are trained
 *   to work in a terminal.
 */

/** Tools that `bash` replaces in bash-first mode, with the shell equivalent shown to the model. */
export const BASH_FIRST_REPLACED = Object.freeze({
  read: "sed -n '1,200p' FILE (or cat FILE for small files; nl -ba FILE | sed -n 'A,Bp' for line numbers)",
  list: 'ls -la DIR',
  glob: "find . -path ./node_modules -prune -o -name 'PATTERN' -print",
  grep: "grep -rnI --exclude-dir=node_modules --exclude-dir=.git 'PATTERN' . (or rg 'PATTERN' if it is installed)",
  repo_map: 'ls, head README*, cat package.json / pyproject.toml / Makefile, then grep for entry points',
  run_tests: "the project's own test command, for example npm test, pytest or go test ./...",
  diagnostics: "the project's own typecheck/lint command, for example npx tsc --noEmit or ruff check",
  environment_status: 'command -v TOOL; node -v; python3 --version',
});

const REPLACED = new Set(Object.keys(BASH_FIRST_REPLACED));

export function normalizeChatToolOptions(value) {
  if (value == null) return { webSearch: true };
  if (typeof value !== 'object' || Array.isArray(value) || (value.webSearch !== undefined && typeof value.webSearch !== 'boolean')) {
    throw Object.assign(new Error('toolOptions.webSearch must be a boolean'), { statusCode: 400 });
  }
  if (value.bashFirst !== undefined && typeof value.bashFirst !== 'boolean') {
    throw Object.assign(new Error('toolOptions.bashFirst must be a boolean'), { statusCode: 400 });
  }
  // `bashFirst` is only present when on, so stored checkpoints and clients that
  // never heard of it keep the exact old shape.
  return { webSearch: value.webSearch !== false, ...(value.bashFirst === true ? { bashFirst: true } : {}) };
}

/**
 * Bash-first only makes sense when `bash` itself is available. Without a shell
 * sandbox the structured tools are the only way to work, so they stay.
 */
export function effectiveToolOptions(options, definitions) {
  if (!options?.bashFirst) return options;
  return definitions.some((tool) => tool.name === 'bash') ? options : { ...options, bashFirst: false };
}

export function filterChatTools(definitions, options) {
  let tools = definitions;
  if (options?.webSearch === false) tools = tools.filter((tool) => tool.name !== 'websearch');
  if (options?.bashFirst) tools = tools.filter((tool) => !REPLACED.has(tool.name));
  return tools;
}

export function assertChatToolAllowed(name, options) {
  const tool = String(name).toLowerCase();
  if (tool === 'websearch' && options?.webSearch === false) throw new Error('Веб-поиск выключен пользователем для этого запроса.');
  if (options?.bashFirst && REPLACED.has(tool)) {
    throw new Error(`The ${tool} tool is not available in this chat (bash-first mode). Use bash instead: ${BASH_FIRST_REPLACED[tool]}.`);
  }
}
