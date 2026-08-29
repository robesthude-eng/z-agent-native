import { buildRepoMap, formatRepoMap } from '../repo-intelligence.mjs';
import { executeGitTool } from '../git-tool.mjs';
import { executeSshTool } from '../ssh-tool.mjs';
import { safeWorkspacePath } from '../security.mjs';
import {
  executeReadFile, executeListFiles, executeGlobFiles, executeGrepFiles, executeWriteFile, executeEditFile, executeApplyPatch,
} from './filesystem.mjs';
import {
  execBash, executeBashTool, externalSpawnIdentity, missingCommandHint, sandboxUidHint,
} from './shell.mjs';
import { executeEnsureEnvironment, executeEnvironmentStatus } from './environment.mjs';
import { executeWebSearch, executeWebFetch } from './web.mjs';
import { executeRunTests, executeDiagnostics } from './diagnostics.mjs';
import { executeBrowserAction } from './browser.mjs';
import { executeMediaAction, isMediaTool } from './media.mjs';

const MAX_TOOL_OUTPUT = 512 * 1024;
const LIVE_OUTPUT_INTERVAL_MS = 250;
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

export function createLiveOutput(onOutput) {
  if (typeof onOutput !== 'function') return { push() {}, stop() {} };
  let timer = null;
  let pending = null;
  let sent = null;
  const flush = () => {
    timer = null;
    const text = pending;
    pending = null;
    if (text == null || text === sent) return;
    sent = text;
    try { onOutput(text); } catch {}
  };
  return {
    push(stdout, stderr) {
      pending = [
        stdout && `stdout:\n${liveTail(stdout)}`,
        stderr && `stderr:\n${liveTail(stderr)}`,
      ].filter(Boolean).join('\n');
      if (timer) return;
      timer = setTimeout(flush, LIVE_OUTPUT_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

export async function executeTool(name, input, ctx = {}) {
  const root = ctx.workspace;
  if (!root) throw new Error('Workspace directory is required for tool execution');
  const tool = String(name || '').toLowerCase();

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

  if (tool === 'write') return executeWriteFile(root, input, ctx.sessionId);
  if (tool === 'edit') return executeEditFile(root, input, ctx.sessionId);
  if (tool === 'apply_patch') {
    const result = await executeApplyPatch(root, input?.patch, ctx.sessionId, ctx.signal);
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

  if (tool === 'ensure_environment') return await executeEnsureEnvironment(root, input, ctx, execBash);
  if (tool === 'environment_status') return executeEnvironmentStatus(root, input);
  if (tool === 'bash') return await executeBashTool(root, input, ctx);
  if (tool === 'websearch') return await executeWebSearch(input, ctx.signal);
  if (tool === 'webfetch') return await executeWebFetch(input, ctx.signal);

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
  if (tool === 'browser') return await executeBrowserAction(root, input, ctx);

  if (isMediaTool(tool)) {
    return await executeMediaAction(tool, root, input, ctx, execBash);
  }

  throw new Error(`Unknown tool: ${name}`);
}
