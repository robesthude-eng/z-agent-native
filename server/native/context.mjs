import { shellSandboxAvailable } from './sandbox.mjs';

const DEFAULT_CONTEXT_CHARS = 360_000;
const DEFAULT_TOOL_OBSERVATION_CHARS = 32_000;
const MIN_CONTEXT_CHARS = 24_000;

// Картинка стоит модели порядка тысячи-двух токенов независимо от размера
// base64, поэтому считаем её фиксированной ценой, а не длиной data URL:
// иначе один скриншот вытеснял из контекста почти всю историю.
const MEDIA_WEIGHT = 6_000;
const KEEP_RUNTIME_MEDIA_FRAMES = 2;

function frameWeight(frame) {
  let n = String(frame?.content || '').length;
  for (const media of frame?.media || []) {
    const raw = String(media?.dataUrl || '');
    n += raw.startsWith('data:image/') ? MEDIA_WEIGHT : Math.min(raw.length, 250_000);
  }
  for (const call of frame?.toolCalls || []) n += JSON.stringify(call?.arguments || {}).length + 256;
  return n;
}

export function contextWeight(frames) {
  return (Array.isArray(frames) ? frames : []).reduce((sum, frame) => sum + frameWeight(frame), 0);
}

function clipMiddle(value, maxChars) {
  const text = String(value ?? '');
  if (text.length <= maxChars) return text;
  const marker = `\n\n[observation compacted: ${text.length - maxChars} chars omitted]\n\n`;
  const remaining = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(remaining * 0.7);
  const tail = remaining - head;
  return `${text.slice(0, head)}${marker}${tail ? text.slice(-tail) : ''}`;
}

function compactObservation(frame, maxChars) {
  if (frame?.role !== 'tool') return frame;
  return { ...frame, content: clipMiddle(frame.content, maxChars) };
}

function isDanglingTool(frames, index) {
  if (frames[index]?.role !== 'tool') return false;
  for (let i = index - 1; i >= 0; i--) {
    if (frames[i]?.role === 'tool') continue;
    return frames[i]?.role !== 'assistant' || !(frames[i]?.toolCalls || []).some((call) => call.id === frames[index].callId);
  }
  return true;
}

function makeToolPairsCoherent(frames) {
  const resultIds = new Set(frames.filter((frame) => frame?.role === 'tool' && frame.callId).map((frame) => frame.callId));
  const out = [];
  for (const frame of frames) {
    if (frame?.role !== 'assistant' || !frame.toolCalls?.length) {
      out.push(frame);
      continue;
    }
    const toolCalls = frame.toolCalls.filter((call) => resultIds.has(call.id));
    if (frame.content || toolCalls.length) out.push({ ...frame, toolCalls });
  }
  return out;
}

/**
 * Bound provider context on every model step, not only when a turn starts.
 * Tool observations are compacted independently before oldest context is
 * dropped. Provider tool-call/result coherence is preserved.
 */
// Pruning of old tool output. The idea (keep the newest ~40k tokens of tool
// results, clear older ones in batches) is taken from opencode's session
// compaction (https://github.com/sst/opencode, MIT License, Copyright (c) 2025
// opencode); this is an independent implementation. Clearing is quantised by
// cumulative size from the START of the history, so the set of cleared frames
// only changes every PRUNE_CHUNK_CHARS of growth and prompt-prefix caches stay valid between.
const DEFAULT_PRUNE_PROTECT_CHARS = 120_000;
const PRUNE_CHUNK_CHARS = 40_000;
const PRUNE_MIN_FRAME_CHARS = 1_200;
const PRUNE_STUB_HEAD_CHARS = 300;
const PRUNE_KEEP_TOOLS = new Set(['skill', 'question', 'task', 'council', 'todowrite', 'memory']);

export function pruneProtectChars(env = process.env) {
  const n = Number(env.Z_AGENT_PRUNE_PROTECT_CHARS ?? DEFAULT_PRUNE_PROTECT_CHARS);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_PRUNE_PROTECT_CHARS;
}

export function pruneOldObservations(input, { protectChars = pruneProtectChars() } = {}) {
  const frames = Array.isArray(input) ? input : [];
  if (!protectChars) return frames;
  const isPrunable = (frame) =>
    frame?.role === 'tool' &&
    !frame.isError &&
    !PRUNE_KEEP_TOOLS.has(frame.name) &&
    String(frame.content || '').length >= PRUNE_MIN_FRAME_CHARS;
  let total = 0;
  for (const frame of frames) if (isPrunable(frame)) total += String(frame.content).length;
  const limit = Math.floor((total - protectChars) / PRUNE_CHUNK_CHARS) * PRUNE_CHUNK_CHARS;
  if (limit <= 0) return frames;
  let seen = 0;
  return frames.map((frame) => {
    if (!isPrunable(frame)) return frame;
    const text = String(frame.content);
    seen += text.length;
    if (seen > limit) return frame;
    const file = text.match(/\.agent-home\/tool-output\/[\w.-]+\.txt/)?.[0];
    const where = file ? ` The full text is still saved in ${file}.` : '';
    return {
      ...frame,
      content: `${text.slice(0, PRUNE_STUB_HEAD_CHARS)}\n[… old tool output cleared to save context (${text.length} chars).${where} Re-run the command or re-read the file if you still need it.]`,
    };
  });
}

export function compactFrames(input, options = {}) {
  const maxChars = Math.max(MIN_CONTEXT_CHARS, Number(options.maxChars || process.env.Z_AGENT_CONTEXT_CHARS) || DEFAULT_CONTEXT_CHARS);
  const maxObservationChars = Math.max(
    4_000,
    Number(options.maxObservationChars || process.env.Z_AGENT_TOOL_OBSERVATION_CHARS) || DEFAULT_TOOL_OBSERVATION_CHARS,
  );
  const frames = pruneOldObservations(input).map((frame) => compactObservation(frame, maxObservationChars));
  // Картинки из view_media нужны модели на ближайших шагах; старые
  // просмотры оставляем только текстом, чтобы не пересылать их каждый шаг.
  let runtimeMediaSeen = 0;
  for (let i = frames.length - 1; i >= 0; i--) {
    if (!frames[i]?.runtimeMedia || !frames[i]?.media?.length) continue;
    runtimeMediaSeen += 1;
    if (runtimeMediaSeen > KEEP_RUNTIME_MEDIA_FRAMES) {
      frames[i] = {
        ...frames[i],
        media: [],
        content: `${frames[i].content} [images no longer attached; call view_media again if you need to look]`,
      };
    }
  }
  const weight = frames.reduce((sum, frame) => sum + frameWeight(frame), 0);
  if (weight <= maxChars) return makeToolPairsCoherent(frames);

  const keep = new Array(frames.length).fill(false);
  let used = 0;
  for (let i = frames.length - 1; i >= 0; i--) {
    const frame = frames[i];
    const w = frameWeight(frame);
    // Skip only the frames that do not fit. Stopping here dropped every older
    // frame because of one oversized observation in the middle of the history.
    if (used > 0 && used + w > maxChars) continue;
    keep[i] = true;
    used += w;
  }

  // A retained tool result must keep the assistant frame that introduced its
  // call. Calls whose results were dropped are filtered out below.
  for (let i = 0; i < frames.length; i++) {
    if (!keep[i] || frames[i]?.role !== 'tool') continue;
    for (let j = i - 1; j >= 0; j--) {
      if (frames[j]?.role === 'tool') continue;
      if (frames[j]?.role === 'assistant' && (frames[j]?.toolCalls || []).some((call) => call.id === frames[i].callId)) keep[j] = true;
      break;
    }
  }

  let out = makeToolPairsCoherent(frames.filter((_, i) => keep[i]));
  while (out.length && isDanglingTool(out, 0)) out.shift();
  out = makeToolPairsCoherent(out);
  return out;
}

const VERIFY_PATTERNS = [
  /\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:test|lint|typecheck|check|build))\b/i,
  /\b(?:pytest|python\s+-m\s+pytest|go\s+test|cargo\s+(?:test|check)|mvn\s+test|gradle\s+test|\.\/gradlew\s+test)\b/i,
  /\b(?:tsc\b|eslint\b|biome\s+check\b|ruff\s+check\b|mypy\b)/i,
  /\bnode\s+--(?:check|test)\b/i,
  /\bpython3?\s+-m\s+(?:compileall|json\.tool|py_compile)\b/i,
  /\b(?:python3?|node)\s+\S*(?:test|spec|check)\S*/i,
  // Built-in and common runners. Interpreter flags may precede the module
  // (`python3 -B -m unittest -v`): stdlib unittest is what agents use when
  // pytest is not installed, and missing it kept the completion gate open
  // after green test runs.
  /\bpython3?(?:\.\d+)?\s+(?:-[A-Za-z]+\s+)*-m\s+(?:unittest|pytest|doctest|mypy|pyflakes|flake8|pylint|ruff\s+check|compileall|py_compile|json\.tool)\b/i,
  /\b(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+(?:exec|dlx))\s+(?:-{1,2}[\w-]+\s+)*(?:vitest|jest|mocha|ava|tsc|eslint|playwright\s+test|cypress\s+run|biome\s+check|prettier\s+--check)\b/i,
  /^\s*(?:vitest|jest|mocha)\b/i,
  /\b(?:deno\s+(?:test|check|lint)|go\s+vet|cargo\s+clippy|dotnet\s+(?:test|build)|swift\s+test|mix\s+test|ctest|phpunit|rspec|flake8|pylint|shellcheck)\b/i,
  /^\s*make\s+(?:test|tests|check|lint)\b/i,
  /^\s*(?:bash|sh)\s+-n\s+\S+/i,
  // Running the program the user asked for is the check. Extra args such as
  // `setup.py install` stay may_mutate so a real installer cannot clear the gate.
  /^\s*(?:python3?|node)\s+(?:-[uBI]+\s+)*\.?\/?[\w.-][\w./-]*\.(?:py|js|mjs|cjs)\s*$/i,
];

// Installing or removing packages changes the environment even when the
// package is named like a checker (`pip install pytest`, `npm i -D eslint`).
const INSTALL_SEGMENT_RE =
  /^\s*(?:sudo\s+)?(?:(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|ci|remove|rm|uninstall|update|upgrade|link)\b|(?:pip3?|pipx|poetry|pdm|conda|mamba)\s+(?:install|add|uninstall|remove)\b|uv\s+(?:pip\s+install|add|remove|sync)\b|python3?\s+-m\s+pip\s+(?:install|uninstall)\b|(?:apt(?:-get)?|apk|dnf|yum|brew|pacman|zypper)\s+\S|(?:cargo|go)\s+(?:install|get)\b|gem\s+install\b|composer\s+(?:install|require|update)\b)/i;

// Summary lines that mean the run failed even if the shell exit status says 0.
const VERIFY_FAILURE_OUTPUT = [
  /^FAILED \((?:failures|errors)=\d+/m, // unittest
  /\b[1-9]\d* (?:failed|errors?)\b[^\n]*\bin [\d.]+\s?s\b/, // pytest summary
  /^\s*Tests?:\s+[1-9]\d* failed/m, // jest
  /^\s*Test Files\s+[1-9]\d* failed/m, // vitest
  /^# fail [1-9]\d*/m, // node --test (TAP)
  /^(?:--- )?FAIL\b/m, // go test
  /test result: FAILED/, // cargo
  /^\s*[1-9]\d* failing\b/m, // mocha
  /\berror TS\d{3,5}:/, // tsc
  /^Traceback \(most recent call last\):/m, // uncaught Python exception
  /^[\s=#*-]*exit(?:\s*code)?\s*[=:]\s*[1-9]\d*[\s=#*-]*$/im, // `echo "exit=$?"` after the check
];

const READ_ONLY_BASH_PATTERNS = [
  /^\s*(?:pwd|ls\b|find\b|cat\b|head\b|tail\b|sed\s+-n\b|grep\b|rg\b|wc\b|du\b|file\b|stat\b|md5sum\b|sha1sum\b|sha256sum\b|cksum\b|echo\b|printf\b|date\b|id\b|whoami\b|uname\b|true\b|false\b|test\b|\[|dirname\b|basename\b|realpath\b|readlink\b|which\b|type\b|cut\b|sort\b|uniq\b|tr\b|nl\b|od\b|hexdump\b|cmp\b|diff\b|comm\b|awk\b|column\b|cd\b|export\b|unset\b)/i,
  // `git -C repo status` is as read-only as `git status`; missing it turned
  // a check like `git -C repo status; npm test` into a fake mutation.
  /^\s*git(?:\s+(?:-C\s+\S+|-c\s+\S+|--no-pager))*\s+(?:status|diff|log|show|branch|rev-parse|blame|ls-files|remote\s+-v|describe)\b/i,
  /^\s*(?:node|npm|npx|python|python3|pip|pip3|go|cargo|rustc|java|javac|ruby|php|deno|bun|git|gcc|make)\s+(?:--version|-v|-V|version)\s*$/i,
  /^\s*(?:npm|pnpm|yarn)\s+(?:ls|list|view|info|outdated|why|root|prefix|config\s+get)\b/i,
  /^\s*(?:pip3?|python3?\s+-m\s+pip)\s+(?:list|show|freeze|check)\b/i,
  /^\s*(?:tree|jq|printenv|ps|df|free|uptime|nproc|lscpu|ss|netstat)\b/i,
  /^\s*(?:curl|wget|ping|traceroute|dig|nslookup|host|ssh_tool\s+(?:test|read|service))\b/i,
];

const STATIC_ASSET_EXTENSIONS = new Set(['html', 'htm', 'css', 'svg', 'md', 'txt', 'json', 'xml', 'csv']);

const ONE_SHOT_MUTATION =
  /\b(?:writeFileSync|writeFile|appendFile|createWriteStream|mkdirSync|rmSync|unlinkSync|write_text|write_bytes|os\.(?:remove|unlink|rmdir|replace)|shutil|pathlib|sed\s+-i|\btee\b|open\s*\([^)]*['"](?:[wax]|r\+))/i;

/** Split a command line into the individual commands it will actually run. */
function bashSegments(text) {
  return String(text || '')
    .split(/\|\||&&|[|;\n]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function stripQuotedStrings(text) {
  return String(text || '').replace(/(['"])(?:\\.|(?!\1)[\s\S])*\1/g, ' ');
}

function stripFdRedirects(text) {
  return String(text || '').replace(/\s+\d*>&\d+\b/g, '');
}

function hasUnquotedRedirectOrSubstitution(text) {
  const stripped = stripQuotedStrings(stripFdRedirects(text));
  return />/.test(stripped) || /\$\(|`/.test(stripped);
}

function classifyOneShotSegment(segment) {
  // Interpreter flags may come first: `python3 -B -c`, `node --input-type=module -e`.
  if (!/^\s*(?:python3?|node)\s+(?:-{1,2}[A-Za-z][\w=-]*\s+)*?-[ce]\s+/i.test(segment)) return null;
  if (ONE_SHOT_MUTATION.test(segment)) return 'may_mutate';
  return 'verification';
}

export function classifyBash(command) {
  const text = String(command || '').trim();
  if (!text) return 'read_only';
  // Only unquoted redirections/substitutions write. `2>&1` and `>` inside
  // `python -c "..."` must not turn a check into a fake workspace mutation.
  if (hasUnquotedRedirectOrSubstitution(text)) return 'may_mutate';
  // A quoted python/node one-liner may contain newlines. Segmenting on `\n`
  // would treat the script body as extra shell commands and never count as a check.
  const oneShotWhole = classifyOneShotSegment(text);
  if (oneShotWhole) return oneShotWhole;
  // Classify every segment. A verification command followed by a mutation
  // (`npm test && sed -i ...`) must not clear the completion gate.
  const segments = bashSegments(text);
  if (!segments.length) return 'read_only';
  let hasVerification = false;
  for (const segment of segments) {
    const oneShot = classifyOneShotSegment(segment);
    if (oneShot === 'may_mutate') return 'may_mutate';
    if (oneShot === 'verification') {
      hasVerification = true;
      continue;
    }
    if (INSTALL_SEGMENT_RE.test(segment)) return 'may_mutate';
    if (VERIFY_PATTERNS.some((rx) => rx.test(segment))) {
      hasVerification = true;
      continue;
    }
    if (READ_ONLY_BASH_PATTERNS.some((rx) => rx.test(segment))) continue;
    return 'may_mutate';
  }
  return hasVerification ? 'verification' : 'read_only';
}

function toolExitOk(result) {
  const exit = Number(result?.metadata?.exit ?? result?.metadata?.git?.exit);
  return !result?.isError && (!Number.isFinite(exit) || exit === 0);
}

/**
 * `pytest | tail`, `npm test; echo "exit=$?"` and `cmd || true` report the
 * status of the last command, not of the check. `&&` chains stop on the first
 * failure, so their exit status is trustworthy.
 */
function checkExitMayBeMasked(command) {
  const parts = stripQuotedStrings(stripFdRedirects(command)).split(/(\|\||&&|[|;\n])/);
  for (let i = 0; i < parts.length; i += 2) {
    const segment = parts[i].trim();
    if (!segment || !VERIFY_PATTERNS.some((rx) => rx.test(segment))) continue;
    const separator = parts[i + 1];
    if (separator && separator !== '&&' && parts.slice(i + 2).some((rest) => rest.trim())) return true;
  }
  return false;
}

export function verificationOutputShowsFailure(content) {
  const text = String(content || '');
  return VERIFY_FAILURE_OUTPUT.some((rx) => rx.test(text));
}

function verificationRunOk(command, result) {
  if (!toolExitOk(result)) return false;
  return !(checkExitMayBeMasked(command) && verificationOutputShowsFailure(result?.content));
}

function commandRecordsGitCommit(command) {
  return /\bgit(?:\s+-c\s+(?:'[^']+'|"[^"]+"|\S+))*\s+commit\b/i.test(String(command || ''));
}

function commandIsGitStatus(command) {
  const useful = bashSegments(command).filter((segment) => !/^\s*cd\b/i.test(segment));
  return useful.length > 0 && useful.every((segment) => /^\s*git\s+status\b/i.test(segment));
}

/** Only git add/commit/status/stage bookkeeping (plus cd): records state, does not change code. */
function commandIsGitBookkeeping(command) {
  const useful = bashSegments(command).filter((segment) => !/^\s*cd\b/i.test(segment));
  return (
    useful.length > 0 &&
    useful.every((segment) => /^\s*git(?:\s+-c\s+(?:'[^']+'|"[^"]+"|\S+))*\s+(?:add|commit|status|stage)\b/i.test(segment))
  );
}

/**
 * The verification signal of this command comes only from inline
 * `node -e` / `python -c` scripts, not from a test/build/lint/typecheck run.
 */
function verificationIsOnlyOneShot(command) {
  const text = String(command || '').trim();
  // A real test/build/lint/typecheck run outside the quoted script bodies settles it.
  if (bashSegments(stripQuotedStrings(text)).some((segment) => VERIFY_PATTERNS.some((rx) => rx.test(segment)))) return false;
  return (
    classifyOneShotSegment(text) === 'verification' ||
    bashSegments(text).some((segment) => classifyOneShotSegment(segment) === 'verification')
  );
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * An inline script proves something about the change only when it touches the
 * changed files: `node -e "console.log(42)"` exits 0 regardless of whether the
 * edited module even parses. With no concrete changed paths (a shell mutation
 * of unknown scope) the binding cannot be checked, so the script is accepted.
 */
function oneShotTouchesChangedPaths(command, changedPaths) {
  const concrete = (changedPaths || [])
    .map((item) =>
      String(item || '')
        .trim()
        .replace(/\\/g, '/'),
    )
    .filter((item) => item && item !== '.');
  if (!concrete.length) return true;
  const text = String(command || '');
  return concrete.some((changed) => {
    const base = changed.split('/').pop() || '';
    const stem = base.replace(/\.[^.]+$/, '');
    if (text.includes(changed) || (base && text.includes(base))) return true;
    return stem.length >= 3 && new RegExp(`(?:^|[^\\w-])${escapeRegExp(stem)}(?:$|[^\\w-])`).test(text);
  });
}

export function gitStatusLooksClean(content) {
  const text = String(content || '');
  if (/^Error:/i.test(text.trim()) || /not a git repository/i.test(text)) return false;
  if (/nothing to commit.*(?:working tree|working directory) clean|working tree clean/i.test(text)) return true;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^exit=-?\d+$/i.test(line)) return false;
      if (/^(?:stdout|stderr):$/i.test(line)) return false;
      if (/^Environment hint:/i.test(line)) return false;
      return true;
    });
  if (!lines.length) return true;
  return lines.every((line) => line.startsWith('##'));
}

function isStaticAssetPath(value) {
  const rel = String(value || '')
    .trim()
    .replace(/\\/g, '/');
  if (!rel || rel === '.' || rel.includes('..') || rel.endsWith('/')) return false;
  const base = rel.split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return false;
  return STATIC_ASSET_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

function staticAssetsVerified(state) {
  const paths = [...new Set([...(state.changedPaths || []), ...(state.pendingReadbacks || [])])];
  return paths.length > 0 && paths.every(isStaticAssetPath);
}

export const MAX_COMPLETION_GATE_REMINDERS = 3;

export function shouldEnforceCompletionGate(strategy, reminders = 0) {
  if (!completionGate(strategy)) return false;
  return Number(reminders) < MAX_COMPLETION_GATE_REMINDERS;
}

export function createTurnStrategy(goal = '') {
  return {
    goal: String(goal || '')
      .trim()
      .slice(0, 8_000),
    plan: [],
    changed: false,
    needsVerification: false,
    pendingReadbacks: [],
    verificationUnavailable: false,
    verificationAttempts: 0,
    lastVerificationOk: null,
    toolErrors: 0,
    mutationEpoch: 0,
    verificationEpoch: -1,
    changedPaths: [],
    lastVerificationEvidence: null,
    gitEvidence: null,
    sawFailedVerification: false,
    checkConfigEdits: [],
  };
}

/**
 * Lint/type/test/CI configuration. Editing it right after a check failed is the classic
 * way an agent "fixes" red output without fixing the code, so such edits are tracked and
 * surfaced to the model and the reviewer. (Idea from the ECC config-protection hook; this is
 * an independent, soft implementation: the edit is allowed, never silent.)
 */
const CHECK_CONFIG_PATH =
  /(?:^|\/)(?:biome\.jsonc?|\.?eslintrc(?:\.[\w]+)?|eslint\.config\.[cm]?[jt]s|\.prettierrc(?:\.[\w]+)?|prettier\.config\.[cm]?[jt]s|tsconfig(?:\.[\w-]+)?\.json|(?:jest|vitest|playwright|cypress)\.config\.[cm]?[jt]s|pytest\.ini|mypy\.ini|\.?ruff\.toml|\.flake8|\.pylintrc|\.golangci\.ya?ml|\.rubocop\.yml|\.stylelintrc(?:\.[\w]+)?|\.pre-commit-config\.yaml|\.husky\/[^/]+|\.github\/workflows\/[^/]+\.ya?ml)$/i;

export function isCheckConfigPath(filePath) {
  return CHECK_CONFIG_PATH.test(
    String(filePath || '')
      .replace(/\\/g, '/')
      .replace(/^\.\//, ''),
  );
}

function normalizeStrategyEvidence(state) {
  if (!Number.isFinite(Number(state.mutationEpoch))) state.mutationEpoch = 0;
  if (!Number.isFinite(Number(state.verificationEpoch))) state.verificationEpoch = -1;
  if (!Array.isArray(state.changedPaths)) state.changedPaths = [];
  if (!('lastVerificationEvidence' in state)) state.lastVerificationEvidence = null;
  if (!('gitEvidence' in state)) state.gitEvidence = null;
  if (!Array.isArray(state.checkConfigEdits)) state.checkConfigEdits = [];
  if (typeof state.sawFailedVerification !== 'boolean') state.sawFailedVerification = false;
  return state;
}

/**
 * Git state is reported separately from verification. A commit or a clean
 * status proves the change is recorded, not that it works, so neither clears
 * the completion gate nor turns the outcome into a verified success.
 */
function noteGitEvidence(state, { action, detail = '' }) {
  normalizeStrategyEvidence(state);
  state.gitEvidence = {
    action: String(action || ''),
    detail: String(detail || '').slice(0, 500),
    mutationEpoch: state.mutationEpoch,
    at: Date.now(),
  };
}

function noteMutation(state, paths = []) {
  normalizeStrategyEvidence(state);
  state.changed = true;
  state.needsVerification = true;
  state.lastVerificationOk = null;
  state.mutationEpoch += 1;
  state.lastVerificationEvidence = null;
  for (const raw of paths) {
    const changedPath = String(raw || '').trim();
    if (!changedPath || state.changedPaths.includes(changedPath)) continue;
    state.changedPaths.push(changedPath);
    if (state.changedPaths.length > 50) state.changedPaths.shift();
  }
}

function noteVerification(state, { ok, tool, detail = '' }) {
  normalizeStrategyEvidence(state);
  state.verificationAttempts += 1;
  if (!ok) state.sawFailedVerification = true;
  state.lastVerificationOk = Boolean(ok);
  state.lastVerificationEvidence = {
    tool: String(tool || ''),
    detail: String(detail || '').slice(0, 500),
    ok: Boolean(ok),
    mutationEpoch: state.mutationEpoch,
    at: Date.now(),
  };
  if (ok) {
    state.needsVerification = false;
    state.verificationEpoch = state.mutationEpoch;
  }
}

const CONTENT_READ_RE = /(?:^|[\s;&|(])(?:cat|sed|head|tail|nl|bat|less|more|grep|rg|awk|diff|git\s+(?:diff|show))\b/;

function commandMentionsPath(command, filePath) {
  if (!CONTENT_READ_RE.test(String(command || ''))) return false;
  const target = String(filePath || '').replace(/^\.\//, '');
  if (!target) return false;
  return String(command || '').includes(target);
}

/** All changed files were read back: close the readback requirement. */
function settleReadbacks(state, tool) {
  if (!state.needsVerification || state.pendingReadbacks.length !== 0) return;
  if (!shellSandboxAvailable()) {
    state.needsVerification = false;
    state.verificationUnavailable = true;
    state.verificationEpoch = state.mutationEpoch;
    state.lastVerificationEvidence = {
      tool,
      detail: 'changed files read back; executable verification unavailable',
      ok: true,
      mutationEpoch: state.mutationEpoch,
      at: Date.now(),
      executable: false,
    };
  } else if (staticAssetsVerified(state)) {
    noteVerification(state, { ok: true, tool, detail: 'static assets read back after the latest change' });
  }
}

export function observeTool(strategy, call, result) {
  const state = normalizeStrategyEvidence(strategy);
  const name = String(call?.name || '').toLowerCase();
  // A runtime gate (e.g. «read before overwrite») is guidance, not a failure of the tool.
  if (result?.isError && !result?.metadata?.runtimeGate) state.toolErrors += 1;

  if (name === 'todowrite' && Array.isArray(result?.metadata?.todos)) {
    state.plan = result.metadata.todos.slice(0, 30).map((todo) => ({
      content: String(todo?.content || '').slice(0, 500),
      status: String(todo?.status || 'pending'),
      priority: String(todo?.priority || 'medium'),
    }));
    return state;
  }

  if (['write', 'edit', 'apply_patch'].includes(name)) {
    if (!result?.isError) {
      const paths = result?.mutatedPaths?.length ? result.mutatedPaths : [call?.arguments?.path].filter(Boolean);
      if (state.sawFailedVerification) {
        for (const changed of paths.filter(isCheckConfigPath)) {
          if (!state.checkConfigEdits.includes(changed)) state.checkConfigEdits.push(changed);
        }
        state.checkConfigEdits = state.checkConfigEdits.slice(-10);
      }
      noteMutation(state, paths);
      if (name === 'write' || name === 'edit') {
        const changedPath = String(call?.arguments?.path || '').trim();
        if (changedPath && !state.pendingReadbacks.includes(changedPath)) state.pendingReadbacks.push(changedPath);
      }
    }
    return state;
  }

  if (name === 'read' && !result?.isError) {
    const readPath = String(call?.arguments?.path || '').trim();
    state.pendingReadbacks = state.pendingReadbacks.filter((changedPath) => changedPath !== readPath);
    settleReadbacks(state, 'read');
    return state;
  }

  if (name === 'bash') {
    const command = String(call?.arguments?.command || '');
    const effect = classifyBash(command);
    if (effect === 'verification') {
      // An unrelated green one-liner is neither a mutation nor a check.
      if (state.needsVerification && verificationIsOnlyOneShot(command) && !oneShotTouchesChangedPaths(command, state.changedPaths))
        return state;
      noteVerification(state, { ok: verificationRunOk(command, result), tool: 'bash', detail: command });
      return state;
    }
    if (commandIsGitBookkeeping(command) && commandRecordsGitCommit(command)) {
      // Staging and committing record the tree; they neither change the code
      // nor prove it, so verification state stays exactly as it was.
      if (toolExitOk(result)) noteGitEvidence(state, { action: 'commit', detail: command });
      return state;
    }
    // Bash-first chats have no `read` tool: reading a changed file back with
    // cat/sed/head/grep counts the same as `read`.
    if (effect === 'read_only' && !result?.isError && state.pendingReadbacks.length > 0) {
      const before = state.pendingReadbacks.length;
      state.pendingReadbacks = state.pendingReadbacks.filter((changedPath) => !commandMentionsPath(command, changedPath));
      if (state.pendingReadbacks.length < before) settleReadbacks(state, 'bash');
    }
    const observed = result?.metadata?.workspaceChanges;
    const changed = observed?.paths?.length > 0 || (!observed?.complete && effect === 'may_mutate');
    if (changed && !result?.isError) {
      noteMutation(state, result?.mutatedPaths?.length ? result.mutatedPaths : ['.']);
      if (commandRecordsGitCommit(command) && toolExitOk(result)) noteGitEvidence(state, { action: 'commit', detail: command });
      return state;
    }
    if (effect === 'read_only' && commandIsGitStatus(command) && toolExitOk(result) && gitStatusLooksClean(result?.content)) {
      noteGitEvidence(state, { action: 'status', detail: command });
    }
    return state;
  }

  if (name === 'git') {
    const action = String(call?.arguments?.action || '')
      .trim()
      .toLowerCase();
    const ok = !result?.isError && Number(result?.metadata?.git?.exit || 0) === 0;
    // Commit, branch and status change or describe Git metadata, not the
    // working tree, so they keep the verification state as it was.
    if ((action === 'commit' || action === 'create_branch') && ok) {
      noteGitEvidence(state, { action, detail: action });
      return state;
    }
    if (action === 'status' && ok && gitStatusLooksClean(result?.content)) {
      noteGitEvidence(state, { action: 'status', detail: 'status' });
    }
    return state;
  }

  // Dedicated verification tools must satisfy the same completion gate as an
  // equivalent bash command. Otherwise the model can run the purpose-built
  // test/typecheck tools successfully and still be forced into a redundant
  // verification loop.
  if (name === 'run_tests') {
    const exit = Number(result?.metadata?.tests?.exit);
    const ok = !result?.isError && Number.isFinite(exit) && exit === 0;
    noteVerification(state, { ok, tool: 'run_tests', detail: String(call?.arguments?.command || 'auto') });
    return state;
  }

  if (name === 'diagnostics') {
    const ok = !result?.isError && result?.metadata?.diagnostics?.ok === true;
    noteVerification(state, {
      ok,
      tool: 'diagnostics',
      detail: String(call?.arguments?.kinds?.join(', ') || call?.arguments?.kind || 'auto'),
    });
    return state;
  }

  // A writer subagent executes behind the parent `task` tool. Its concrete
  // edits are surfaced through mutatedPaths, so the parent turn must inherit
  // the changed/needs-verification state instead of being allowed to finish as
  // if the delegated work were read-only.
  if (name === 'task' && !result?.isError && result?.mutatedPaths?.length) {
    noteMutation(state, result.mutatedPaths);
  }

  if (name === 'visual_check' && !result?.isError) {
    state.visualEpoch = state.mutationEpoch;
    const consoleErrors = Boolean(result?.metadata?.visualCheck?.consoleErrors);
    const paths = Array.isArray(state.changedPaths) ? state.changedPaths : [];
    const onlyFrontend =
      paths.length > 0 &&
      paths.every(
        (p) =>
          /\.(html?|css|scss|sass|less|svg|png|jpe?g|webp|gif|ico|json|md|txt)$/i.test(String(p)) ||
          /(^|\/)\.screenshots\//.test(String(p)),
      );
    if (state.needsVerification && onlyFrontend && !consoleErrors) {
      noteVerification(state, { ok: true, tool: 'visual_check', detail: String(call?.arguments?.url || 'index.html') });
    }
    return state;
  }

  if (name === 'browser' && !result?.isError) {
    const action = String(call?.arguments?.action || '').toLowerCase();
    const url = String(call?.arguments?.url || '');
    const local = Boolean(call?.arguments?.html) || (url && !/^https?:\/\//i.test(url));
    if ((action === 'open' || action === 'snapshot') && local && state.needsVerification) {
      noteVerification(state, { ok: true, tool: 'browser', detail: url || 'workspace document' });
    }
  }

  return state;
}

export function completionGate(strategy) {
  if (!strategy?.needsVerification) return null;
  if (!shellSandboxAvailable()) {
    // No shell means verification is impossible, not that the change is proven.
    // Degrade to a mandatory read-back instead of silently dropping the gate.
    return [
      '[Runtime completion gate]',
      'The workspace changed and no executable verification is available in this runtime (no shell sandbox).',
      `Do not finish yet. Re-read every file you changed${strategy.pendingReadbacks?.length ? `: ${strategy.pendingReadbacks.join(', ')}` : ''}, confirm the edit is complete and internally consistent, and state in the final answer that automated verification was unavailable.`,
    ].join('\n');
  }
  return [
    '[Runtime completion gate]',
    'The workspace may have changed, but no successful verification has happened after the latest change.',
    'Do not finish yet. Inspect the resulting diff/state and run the most relevant available test, build, typecheck, lint, syntax check, or another executable validation of the changed behavior.',
    'A read-only command such as git diff/status is useful inspection but does not by itself satisfy verification, and a commit records the change without proving it. An inline node -e/python -c script counts only when it exercises the changed files.',
    'If verification cannot be run, investigate why and explicitly report the limitation only after reasonable attempts.',
  ].join('\n');
}

function htmlPagesWithoutIndex(strategy) {
  const paths = Array.isArray(strategy?.changedPaths) ? strategy.changedPaths : [];
  const html = paths.filter((item) => /\.html?$/i.test(String(item || '')) && !String(item).includes('/'));
  const hasIndex = html.some((item) => /^index\.html?$/i.test(item));
  // Единственная корневая страница откроется в превью автоматически (fallback
  // выбирает её), так что подсказка не нужна. Она полезна, только когда корневых
  // страниц несколько и index.html среди них нет: превью возьмёт самую свежую,
  // и это может оказаться не та страница.
  if (!html.length || hasIndex || html.length === 1) return [];
  return html;
}

export function strategyGuidance(strategy) {
  const lines = ['[Native turn strategy]'];
  if (strategy?.goal) lines.push(`Goal: ${strategy.goal}`);
  if (strategy?.plan?.length) {
    lines.push('Current plan:');
    for (const todo of strategy.plan.slice(0, 20)) lines.push(`- [${todo.status}] ${todo.content}`);
  }
  if (strategy?.changedPaths?.length) lines.push(`Changed paths (latest tracked set): ${strategy.changedPaths.slice(-12).join(', ')}`);
  if (strategy?.checkConfigEdits?.length) {
    lines.push(
      `You edited check configuration (${strategy.checkConfigEdits.slice(-4).join(', ')}) after a check failed in this turn. Fix the code so the check passes, do not loosen the check, unless the user asked for that configuration change; if you keep it, say so and why in the final answer.`,
    );
  }
  const misplaced = htmlPagesWithoutIndex(strategy);
  if (misplaced.length) {
    lines.push(
      `The in-product Preview panel opens index.html at the root, or the newest root-level HTML when there is no index.html. You wrote several root pages (${misplaced.slice(-4).join(', ')}) — write or rename the main page to index.html so the preview shows the right one.`,
    );
  }
  if (strategy?.needsVerification && shellSandboxAvailable())
    lines.push(
      'Workspace state: changed since the last successful executable verification; verification is required before completion. Prefer a test/check that covers the changed paths above rather than an unrelated green command.',
    );
  else if (strategy?.needsVerification)
    lines.push(
      'Workspace state: changed, but executable verification is unavailable in this runtime. Inspect the changed files with read/grep and report this verification limitation explicitly.',
    );
  else if (strategy?.changed && strategy?.lastVerificationOk)
    lines.push(
      `Workspace state: mutation epoch ${strategy.mutationEpoch ?? 0} has successful verification evidence${strategy.lastVerificationEvidence?.detail ? ` (${strategy.lastVerificationEvidence.tool}: ${strategy.lastVerificationEvidence.detail})` : ''}.`,
    );
  else if (strategy?.changed && strategy?.verificationUnavailable)
    lines.push(
      'Workspace state: changed files were read back successfully; executable verification was unavailable and must be disclosed in the final answer.',
    );
  return lines.join('\n');
}
