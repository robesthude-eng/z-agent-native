import { spawn } from 'node:child_process';
import path from 'node:path';
import { DEFAULT_TOOL_TIMEOUT_MS } from '../config.mjs';
import { managedShellEnvironment } from '../environment.mjs';
import { EXTENDED_TOOLCHAIN_KINDS, suggestToolchainForCommand } from '../toolchains.mjs';
import { classifyBash } from '../context.mjs';
import {
  prepareWorkspaceSandbox, sandboxCommand, sandboxIdentity, shellSandboxAvailable, syncSandboxOwnership,
} from '../sandbox.mjs';
import { executeInExecutor, executorRequired } from '../executor-client.mjs';
import { assertShellCommandAllowed, shellNetworkPolicy } from '../workspace-policy.mjs';

const BASE_ENVIRONMENT_KINDS = ['python', 'java', 'gradle', 'android'];
const ENVIRONMENT_KINDS = [...BASE_ENVIRONMENT_KINDS, ...EXTENDED_TOOLCHAIN_KINDS];

export function externalSpawnIdentity(ctx, root) {
  if (ctx?.sessionId && shellSandboxAvailable()) {
    const id = sandboxIdentity(ctx.sessionId);
    if (id?.isolated) return id;
  }
  return { isolated: false, uid: process.getuid ? process.getuid() : 0, gid: process.getgid ? process.getgid() : 0, home: root };
}

export function missingCommandHint(result) {
  const text = [result?.stderr || '', result?.stdout || ''].join('\n');
  const match = text.match(/(?:(?:command not found|not found|No such file or directory):\s*([a-zA-Z0-9_-]+)|([a-zA-Z0-9_-]+):\s*(?:command not found|not found))/i);
  const raw = (match?.[1] || match?.[2] || '').trim().toLowerCase();
  if (!raw) return null;
  const kind = suggestToolchainForCommand(raw);
  if (kind && ENVIRONMENT_KINDS.includes(kind)) return { command: raw, kind };
  return null;
}

export function sandboxUidHint(result) {
  const text = [result?.stderr || '', result?.stdout || ''].join('\n');
  const match = text.match(/No user exists for uid\s+(\d+)/i);
  if (!match) return null;
  return { uid: Number(match[1]) };
}

export async function execBash(root, command, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS, signal, ctx = {}) {
  if (executorRequired()) {
    return await executeInExecutor(root, command, {
      timeoutMs,
      signal,
      sessionId: ctx.sessionId,
      stdin: ctx.stdin,
    });
  }

  const effectiveTimeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TOOL_TIMEOUT_MS, 1000), 1_800_000);
  return await localBashWorker(root, command, effectiveTimeout, signal, ctx);
}

export function localBashWorker(root, command, timeoutMs, signal, ctx = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    if (signal?.aborted) {
      return resolve({ code: 130, stdout: '', stderr: 'Command aborted' });
    }

    const { env: managedEnv, pathPrefix } = managedShellEnvironment(root);
    const env = {
      ...process.env,
      ...managedEnv,
      TERM: 'dumb',
      CI: 'true',
      HOME: root,
      PWD: root,
      WORKSPACE_DIR: root,
      PATH: pathPrefix ? `${pathPrefix}:${process.env.PATH || ''}` : (process.env.PATH || ''),
      LC_ALL: 'C.UTF-8',
      LANG: 'C.UTF-8',
      // Block common credential env overrides inside the spawned shell.
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      Z_AGENT_SECRET_KEY: '',
      Z_AGENT_AUDIT_KEY: '',
    };

    let child;
    if (ctx.sessionId && shellSandboxAvailable()) {
      prepareWorkspaceSandbox(ctx.sessionId, root);
      const plan = sandboxCommand(ctx.sessionId, root, command, { env, stdin: ctx.stdin });
      child = spawn(plan.command, plan.args, {
        cwd: plan.cwd,
        env: plan.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      child = spawn('bash', ['-c', command], {
        cwd: root,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);

    const onAbort = () => {
      try { child.kill('SIGKILL'); } catch {}
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    if (ctx.stdin) {
      try {
        child.stdin.write(ctx.stdin);
        child.stdin.end();
      } catch {}
    } else {
      try { child.stdin.end(); } catch {}
    }

    const MAX_ACCUM_CHARS = 1_000_000;
    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_ACCUM_CHARS) stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_ACCUM_CHARS) stderr += d.toString();
    });

    child.on('close', (code, sig) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);

      if (ctx.sessionId && shellSandboxAvailable()) {
        try { syncSandboxOwnership(ctx.sessionId, root); } catch {}
      }

      if (timedOut) {
        resolve({
          code: 124,
          stdout,
          stderr: (stderr ? stderr + '\n' : '') + `Command timed out after ${(timeoutMs / 1000).toFixed(0)}s`,
        });
      } else {
        resolve({
          code: code ?? (sig ? 128 : 0),
          stdout,
          stderr,
        });
      }
    });

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: 1, stdout: '', stderr: `Failed to execute: ${err.message}` });
    });
  });
}

export async function executeBashTool(root, input, ctx = {}) {
  const command = String(input?.command || '');
  assertShellCommandAllowed(command);
  const result = await execBash(root, command, Number(input?.timeoutMs) || DEFAULT_TOOL_TIMEOUT_MS, ctx.signal, ctx);
  const hint = missingCommandHint(result);
  const uidHint = sandboxUidHint(result);
  const body = [
    `exit=${result.code}`,
    result.stdout && `stdout:\n${result.stdout}`,
    result.stderr && `stderr:\n${result.stderr}`,
    hint && `Environment hint: command "${hint.command}" is missing. Use ensure_environment with kind="${hint.kind}" and then continue the original task; lack of sudo/root is not a reason to stop.`,
    uidHint && `Environment hint: OpenSSH failed because this session runs under isolated uid ${uidHint.uid}, which has no /etc/passwd entry. This is expected and permanent - the host, the key and the remote username are not the problem, and retrying ssh/scp/sftp from bash will fail identically. Use the ssh_tool tool instead (action=test, exec, read, write, patch, service); it connects over paramiko and never reads the passwd database.`,
  ].filter(Boolean).join('\n');
  return {
    output: body,
    title: command,
    mutatedPaths: classifyBash(command) === 'read_only' ? [] : ['.'],
    metadata: {
      exit: result.code,
      shellNetworkPolicy: shellNetworkPolicy(),
      ...(hint ? { environmentHint: hint } : {}),
      ...(uidHint ? { sandboxUidHint: uidHint } : {}),
    },
  };
}
