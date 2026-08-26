import { spawn } from 'node:child_process';
import path from 'node:path';
import { DEFAULT_TOOL_TIMEOUT_MS } from '../config.mjs';
import { managedShellEnvironment } from '../environment.mjs';
import { EXTENDED_TOOLCHAIN_KINDS, suggestToolchainForCommand } from '../toolchains.mjs';
import { classifyBash } from '../context.mjs';
import {
  ensureManagedHome, prepareWorkspaceSandbox, sandboxCommand, shellSandboxAvailable, syncSandboxOwnership,
} from '../sandbox.mjs';
import { executeInExecutor } from '../executor-client.mjs';
import { assertShellCommandAllowed, shellNetworkPolicy } from '../workspace-policy.mjs';
import { createLiveOutput, truncate } from './dispatcher.mjs';

const BASE_ENVIRONMENT_KINDS = ['python', 'java', 'gradle', 'android'];
const ENVIRONMENT_KINDS = [...BASE_ENVIRONMENT_KINDS, ...EXTENDED_TOOLCHAIN_KINDS];

export function externalSpawnIdentity(ctx, root) {
  if (ctx?.sessionId) return prepareWorkspaceSandbox(ctx.sessionId, root);
  if (process.env.Z_AGENT_ALLOW_UNISOLATED_SHELL === '1') return { isolated: false };
  throw new Error('External tool execution requires a session sandbox');
}

export function missingCommandHint(result) {
  if (result?.code !== 127) return null;
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  const matches = [...text.matchAll(/(?:^|\n)(?:[^\n]*?:\s*)?([A-Za-z0-9._+-]+): command not found\b/gm)];
  for (const match of matches) {
    const hint = suggestToolchainForCommand(match[1]);
    if (hint) return hint;
  }
  return null;
}

const UID_LOOKUP_FAILURE = /No user exists for uid (\d+)/i;

export function sandboxUidHint(result) {
  const match = `${result?.stderr || ''}\n${result?.stdout || ''}`.match(UID_LOOKUP_FAILURE);
  return match ? { uid: match[1], useTool: 'ssh_tool' } : null;
}

export async function execBash(root, command, timeoutMs = DEFAULT_TOOL_TIMEOUT_MS, signal, ctx = {}) {
  const identity = externalSpawnIdentity(ctx, root);
  const home = ensureManagedHome(ctx?.sessionId, root);
  const env = managedShellEnvironment(root, {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: home,
    USER: 'agent',
    LANG: process.env.LANG || 'C.UTF-8',
    LC_ALL: process.env.LC_ALL || '',
    TERM: 'xterm-256color',
  });

  if (identity?.isolated) {
    const remote = await executeInExecutor({
      workspace: root, uid: identity.uid, gid: identity.gid,
      file: '/bin/bash', args: ['--noprofile', '--norc', '-c', command],
      env, timeoutMs, signal,
    });
    if (remote) return remote;
  }

  const launch = sandboxCommand(identity, '/bin/bash', ['--noprofile', '--norc', '-c', command]);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.file, launch.args, {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      ...launch.options,
    });
    let stdout = '';
    let stderr = '';
    const live = createLiveOutput(ctx?.onOutput);
    const push = (which, chunk) => {
      const next = Buffer.from(chunk).toString('utf8');
      if (which === 'out') stdout = truncate(stdout + next);
      else stderr = truncate(stderr + next);
      live.push(stdout, stderr);
    };
    child.stdout.on('data', (c) => push('out', c));
    child.stderr.on('data', (c) => push('err', c));

    let forceKillTimer = null;
    const killGroup = (sig = 'SIGTERM') => {
      try { process.kill(-child.pid, sig); } catch { try { child.kill(sig); } catch {} }
    };
    const abort = () => {
      killGroup('SIGTERM');
      forceKillTimer = setTimeout(() => killGroup('SIGKILL'), 1000);
      forceKillTimer.unref?.();
    };
    signal?.addEventListener('abort', abort, { once: true });

    let timeout = null;
    if (timeoutMs) {
      timeout = setTimeout(() => {
        stderr = truncate(`${stderr ? stderr + '\n' : ''}Command exceeded limit of ${timeoutMs} ms and was terminated.`);
        abort();
      }, timeoutMs);
      timeout.unref?.();
    }

    child.on('error', (err) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', abort);
      live.stop();
      reject(err);
    });
    child.on('close', (code, sig) => {
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      signal?.removeEventListener('abort', abort);
      live.stop();
      if (!forceKillTimer) killGroup('SIGTERM');
      resolve({ code: code ?? (sig ? 130 : 1), stdout, stderr, signal: sig || null });
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
