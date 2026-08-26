import { executeGitTool } from '../git-tool.mjs';
import { buildRepoMap, formatRepoMap } from '../repo-intelligence.mjs';
import { executeSshTool } from '../ssh-tool.mjs';
import { executeBrowserAction } from './browser.mjs';
import { executeDiagnostics, executeRunTests } from './diagnostics.mjs';
import { executeEnsureEnvironment, executeEnvironmentStatus } from './environment.mjs';
import {executeApplyPatch,executeEditFile, executeGlobFiles, executeGrepFiles, executeListFiles, 
  executeReadFile, executeWriteFile, 
} from './filesystem.mjs';
import { executeMediaAction, isMediaTool } from './media.mjs';
import { getTool } from './registry.mjs';
import {
  execBash, executeBashTool, externalSpawnIdentity, missingCommandHint, sandboxUidHint,
} from './shell.mjs';
import { executeWebFetch, executeWebSearch } from './web.mjs';

const MAX_TOOL_OUTPUT = 512 * 1024;

export function truncate(text, max = MAX_TOOL_OUTPUT) {
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max)}\n\n(Output truncated at ${(max / 1024).toFixed(0)} KB limit)`;
}

export function textResult(res) {
  if (typeof res === 'string') return res;
  if (res && typeof res === 'object') {
    if (typeof res.text === 'string') return res.text;
    if (typeof res.output === 'string') return res.output;
    try {
      return JSON.stringify(res, null, 2);
    } catch {
      return String(res);
    }
  }
  return String(res ?? '');
}

export function toolOutputText(result) {
  return truncate(textResult(result?.output ?? result));
}

export function createLiveOutput(part, emit) {
  let timer = null;
  let pending = '';
  return {
    push(chunk) {
      if (!chunk) return;
      pending += chunk;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (!pending) return;
        part.text += pending;
        pending = '';
        emit();
      }, 80);
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending) {
        part.text += pending;
        pending = '';
        emit();
      }
    },
  };
}

/**
 * Central tool dispatch boundary.
 * Tool modules should register handlers here instead of growing tools.mjs.
 */
export async function dispatchTool(name, input, context) {
  const handler = getTool(name);
  if (handler && typeof handler === 'function') {
    return handler(input, context);
  }
  return executeTool(name, input, context);
}

export async function executeTool(name, input, ctx = {}) {
  const root = ctx.workspace;
  if (!root) throw new Error('Workspace directory is required for tool execution');
  const tool = String(name || '').trim();

  if (tool === 'read') return await executeReadFile(root, input);
  if (tool === 'list') return executeListFiles(root, input);
  if (tool === 'glob') return executeGlobFiles(root, input);
  if (tool === 'grep') return await executeGrepFiles(root, input, ctx);

  if (tool === 'repo_map') {
    const report = await buildRepoMap(root, input || {});
    return {
      output: formatRepoMap(report),
      title: report.root,
      metadata: { repoMap: report },
    };
  }

  if (tool === 'write') return executeWriteFile(root, input, ctx.sessionId);
  if (tool === 'edit') return executeEditFile(root, input, ctx.sessionId);
  if (tool === 'apply_patch') return await executeApplyPatch(root, input?.patch, ctx.sessionId, ctx.signal, execBash);

  if (tool === 'todowrite') {
    return {
      output: 'Todos updated',
      title: 'todowrite',
      metadata: { todos: input?.todos || [] },
    };
  }

  if (tool === 'task') {
    throw new Error('Subagents must be executed by the agent runtime, not the generic tool executor');
  }

  if (tool === 'ensure_environment') return await executeEnsureEnvironment(root, input, ctx, execBash);
  if (tool === 'environment_status') return executeEnvironmentStatus(root, input);
  if (tool === 'bash') return await executeBashTool(root, input, ctx);
  if (tool === 'websearch') return await executeWebSearch(input, ctx.signal);
  if (tool === 'webfetch') return await executeWebFetch(input, ctx.signal);

  if (tool === 'git') {
    const result = await executeGitTool({
      root,
      identity: externalSpawnIdentity(ctx, root),
      input: input || {},
      signal: ctx.signal,
      sessionId: ctx.sessionId,
    });
    const writes = ['commit', 'create_branch'].includes(String(input?.action || '').toLowerCase());
    return writes ? { ...result, mutatedPaths: ['.'] } : result;
  }

  if (tool === 'ssh_tool') {
    return await executeSshTool({
      root,
      identity: externalSpawnIdentity(ctx, root),
      input: input || {},
      signal: ctx.signal,
      sessionId: ctx.sessionId,
    });
  }

  if (tool === 'run_tests') return await executeRunTests(root, input, ctx, execBash);
  if (tool === 'diagnostics') return await executeDiagnostics(root, input, ctx, execBash);
  if (tool === 'browser') return await executeBrowserAction(root, input, ctx);

  if (isMediaTool(tool)) {
    return await executeMediaAction(tool, root, input, ctx, execBash);
  }

  throw new Error(`Unknown tool: ${name}`);
}
