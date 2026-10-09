import { executeCloudSandbox } from '../cloud-sandbox.mjs';
import { syncSandboxOwnership } from '../sandbox.mjs';
import { normalizeBrowserInput } from '../browser-client.mjs';
import { executeGitTool } from '../git-tool.mjs';
import { buildRepoMap, formatRepoMap } from '../repo-intelligence.mjs';
import { safeWorkspacePath } from '../security.mjs';
import { executeSshTool } from '../ssh-tool.mjs';
import { executeMemoryTool, executeSkillTool } from '../agent-memory.mjs';
import { executeBackgroundTool } from '../background-jobs.mjs';
import { executeBrowserAction, executeVisualCheck } from './browser.mjs';
import { TOOL_DEFINITIONS } from './definitions.mjs';
import { createProgressLog } from './progress.mjs';
import { executeDiagnostics, executeRunTests } from './diagnostics.mjs';
import { executeEnsureEnvironment, executeEnvironmentStatus } from './environment.mjs';
import {
  executeApplyPatch,
  executeEditFile,
  executeGlobFiles,
  executeGrepFiles,
  executeListFiles,
  executeReadFile,
  executeWriteFile,
} from './filesystem.mjs';
import { executeMediaAction, isMediaTool } from './media.mjs';
import { execBash, executeBashTool, externalSpawnIdentity } from './shell.mjs';
import { withSyntaxCheck } from './syntax-check.mjs';
import { ToolArgumentsError, validateToolInput } from './validate.mjs';
import { executeWebFetch, executeWebSearch } from './web.mjs';

const MAX_TOOL_OUTPUT = 512 * 1024;
const LIVE_OUTPUT_INTERVAL_MS = 100;
const LIVE_OUTPUT_TAIL = 4000;

function rel(root, full) {
  return full.startsWith(root) ? full.slice(root.length).replace(/^[/\\]+/, '') : full;
}

export function truncate(text, max = MAX_TOOL_OUTPUT) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}\n\n[output truncated: ${s.length - max} chars omitted]`;
}

export function textResult(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export function toolOutputText(result) {
  return truncate(textResult(result?.output ?? result));
}

function liveTail(text) {
  const s = String(text ?? '');
  if (s.length <= LIVE_OUTPUT_TAIL) return s;
  return `[…показан только конец вывода]\n${s.slice(-LIVE_OUTPUT_TAIL)}`;
}

export function createLiveOutput(onOutput, { intervalMs = LIVE_OUTPUT_INTERVAL_MS, now = Date.now } = {}) {
  if (typeof onOutput !== 'function') return { push() {}, stop() {} };
  let timer = null;
  let pending = null;
  let sent = null;
  let lastSent = 0;
  let stopped = false;
  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const text = pending;
    pending = null;
    if (stopped || text == null || text === sent) return;
    sent = text;
    lastSent = now();
    try {
      onOutput(text);
    } catch {}
  };
  return {
    // Leading edge: the first chunk after a quiet period is shown immediately;
    // a burst afterwards is coalesced into at most one update per interval and
    // the last state is always delivered (trailing edge).
    push(stdout, stderr) {
      pending = [stdout && `stdout:\n${liveTail(stdout)}`, stderr && `stderr:\n${liveTail(stderr)}`].filter(Boolean).join('\n');
      if (timer) return;
      const wait = intervalMs - (now() - lastSent);
      if (wait <= 0) {
        flush();
        return;
      }
      timer = setTimeout(flush, wait);
      timer.unref?.();
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

export function assertValidToolInput(name, input) {
  const tool = String(name || '').toLowerCase();
  const definition = TOOL_DEFINITIONS.find((d) => d.name === tool);
  if (!definition) return input || {};
  const prepared = tool === 'browser' ? normalizeBrowserInput(input || {}) : input || {};
  const { ok, value, errors } = validateToolInput(definition.inputSchema, prepared);
  if (!ok) throw new ToolArgumentsError(tool, errors, definition.inputSchema);
  return value;
}

/**
 * Run a tool that has no process output of its own with a status timeline
 * (`ctx.progress`) wired to the live-output channel of its card.
 */
async function withProgress(ctx, run) {
  const progress = createProgressLog(ctx?.onOutput);
  try {
    return await run({ ...ctx, progress });
  } finally {
    progress.stop();
  }
}

export async function executeTool(name, input, ctx = {}) {
  const root = ctx.workspace;
  if (!root) throw new Error('Workspace directory is required for tool execution');
  const tool = String(name || '').toLowerCase();
  // Аргументы проверяются по схеме до любого действия (включая вызовы субагентов).
  input = assertValidToolInput(tool, input);

  if (tool === 'question') return { kind: 'question', questions: Array.isArray(input?.questions) ? input.questions : [] };

  if (tool === 'read') return await executeReadFile(root, input);
  if (tool === 'list') return executeListFiles(root, input);
  if (tool === 'glob') return executeGlobFiles(root, input);
  if (tool === 'grep') return await executeGrepFiles(root, input);

  if (tool === 'repo_map') {
    const scope = safeWorkspacePath(root, input?.path || '.', { allowMissing: false });
    const map = buildRepoMap(root, scope, {
      maxFiles: Math.min(Math.max(Number(input?.maxFiles) || 2500, 100), 8000),
      maxSymbolsPerFile: Math.min(Math.max(Number(input?.maxSymbolsPerFile) || 8, 0), 20),
    });
    return {
      output: formatRepoMap(map),
      title: `Repository map: ${rel(root, scope) || '.'}`,
      metadata: { repoMap: { scope: map.scope, fileCount: map.fileCount, truncated: map.truncated } },
    };
  }

  if (tool === 'write') return await withSyntaxCheck(root, executeWriteFile(root, input, ctx.sessionId));
  if (tool === 'edit') return await withSyntaxCheck(root, executeEditFile(root, input, ctx.sessionId));
  if (tool === 'apply_patch') {
    // applyGitPatch(root, patchText, signal, ctx): the session id travels inside ctx.
    const result = await executeApplyPatch(root, input?.patch, ctx.signal, ctx);
    return { ...result, mutatedPaths: ['.'] };
  }

  if (tool === 'todowrite') {
    const todos = Array.isArray(input?.todos) ? input.todos.slice(0, 30) : [];
    const lines = todos.map((todo, i) => `${i + 1}. [${todo.status || 'pending'}] ${String(todo.content || '')}`);
    return { output: lines.join('\n') || 'Todo list cleared', title: 'Updated todos', metadata: { todos } };
  }

  if (tool === 'task') {
    throw new Error('task is executed by the agent runtime, not the generic tool executor');
  }

  if (tool === 'council') {
    throw new Error('council is executed by the agent runtime, not the generic tool executor');
  }

  if (tool === 'ensure_environment') return await executeEnsureEnvironment(root, input, ctx, execBash);
  if (tool === 'environment_status') return executeEnvironmentStatus(root, input);
  if (tool === 'bash') return await executeBashTool(root, input, ctx);
  if (tool === 'background') return await executeBackgroundTool(root, input, ctx);
  if (tool === 'visual_check') return await withProgress(ctx, (c) => executeVisualCheck(root, input, c));
  if (tool === 'memory') return executeMemoryTool(input, ctx);
  if (tool === 'skill') return executeSkillTool(input, ctx);
  if (tool === 'websearch') return await withProgress(ctx, (c) => executeWebSearch(input, ctx.signal, c.progress));
  if (tool === 'cloud_sandbox') {
    return await withProgress(ctx, (c) =>
      executeCloudSandbox(root, input || {}, {
        sessionId: ctx.sessionId,
        signal: ctx.signal,
        progress: c.progress,
        chownToSession: ctx.sessionId ? (target) => syncSandboxOwnership(ctx.sessionId, root, target) : null,
      }),
    );
  }
  if (tool === 'webfetch') return await withProgress(ctx, (c) => executeWebFetch(input, ctx.signal, c.progress));

  if (tool === 'git') {
    // clone/fetch/pull идут десятками секунд и раньше не показывали ничего до самого
    // завершения. Прогресс git пишет в stderr, поэтому важно отдавать оба потока.
    const live = createLiveOutput(ctx?.onOutput);
    let result;
    try {
      result = await executeGitTool({
        root,
        identity: externalSpawnIdentity(ctx, root),
        input: input || {},
        signal: ctx.signal,
        sessionId: ctx.sessionId,
        onOutput: (stdout, stderr) => live.push(stdout, stderr),
      });
    } finally {
      live.stop();
    }
    const writes = ['commit', 'create_branch'].includes(String(input?.action || '').toLowerCase());
    return writes ? { ...result, mutatedPaths: ['.'] } : result;
  }

  if (tool === 'ssh_tool') {
    // executeSshTool уже отдаёт stdout/stderr по мере поступления, но раньше
    // callback никто не передавал, и карточка оставалась пустой до конца сессии.
    // Пропускаем через тот же буфер, что и bash: иначе каждый чанк порождал бы
    // отдельное SSE-событие.
    const live = createLiveOutput(ctx?.onOutput);
    try {
      return await executeSshTool({
        root,
        identity: externalSpawnIdentity(ctx, root),
        input: input || {},
        signal: ctx.signal,
        sessionId: ctx.sessionId,
        onOutput: (stdout, stderr) => live.push(stdout, stderr),
      });
    } finally {
      live.stop();
    }
  }

  if (tool === 'run_tests') return await executeRunTests(root, input, ctx, execBash);
  if (tool === 'diagnostics') return await executeDiagnostics(root, input, ctx, execBash);
  if (tool === 'browser') return await withProgress(ctx, (c) => executeBrowserAction(root, input, c));

  if (isMediaTool(tool)) {
    return await executeMediaAction(tool, root, input, ctx, execBash);
  }

  throw new Error(`Unknown tool: ${name}`);
}
