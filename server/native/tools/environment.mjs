import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_TOOL_TIMEOUT_MS } from '../config.mjs';
import {
  commitEnvironmentRequirement, describeManagedEnvironment, managedShellEnvironment, prepareEnvironmentRequirement,
} from '../environment.mjs';
import { executorRequired } from '../executor-client.mjs';
import { ensureManagedHome } from '../sandbox.mjs';
import { EXTENDED_TOOLCHAIN_KINDS, prepareToolchainRequirement } from '../toolchains.mjs';
import { agentNetworkPolicy } from '../workspace-policy.mjs';

const BASE_ENVIRONMENT_KINDS = ['python', 'java', 'gradle', 'android'];

export function environmentCommandStatus(root, commands = []) {
  const { pathPrefix } = managedShellEnvironment(root);
  const searchDirs = [
    ...(pathPrefix ? pathPrefix.split(path.delimiter) : []),
    ...(process.env.PATH || '').split(path.delimiter),
  ].filter(Boolean);

  const status = {};
  for (const raw of commands) {
    const command = String(raw || '').trim();
    if (!command) continue;
    let found = false;
    for (const dir of searchDirs) {
      const candidate = path.join(dir, command);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          found = true;
          status[command] = { available: true, path: candidate };
          break;
        }
      } catch {}
    }
    if (!found) status[command] = { available: false, path: null };
  }
  return status;
}

export async function executeEnsureEnvironment(root, input, ctx = {}, execBash) {
  if (executorRequired() && process.env.Z_AGENT_ALLOW_NETWORKED_INSTALLERS !== '1') {
    throw Object.assign(
      new Error('ensure_environment is disabled in hardened executor mode. Bake dependencies into the image or provision them through an operator-controlled workflow.'),
      { statusCode: 403, code: 'NETWORKED_INSTALLER_DISABLED' }
    );
  }
  if (agentNetworkPolicy() !== 'public') {
    throw Object.assign(
      new Error('ensure_environment is disabled when Z_AGENT_NETWORK_POLICY is allowlist/off because its package/toolchain installers can contact multiple external registries. Provision dependencies outside the autonomous turn or use public policy in a trusted environment.'),
      { statusCode: 403, code: 'AGENT_NETWORK_BLOCKED' }
    );
  }
  const kind = String(input?.kind || '').trim().toLowerCase();
  const plan = BASE_ENVIRONMENT_KINDS.includes(kind)
    ? prepareEnvironmentRequirement(root, input || {})
    : prepareToolchainRequirement(root, input || {});
  if (ctx.sessionId) ensureManagedHome(ctx.sessionId, root);
  const result = await execBash(root, plan.script, Number(input?.timeoutMs) || DEFAULT_TOOL_TIMEOUT_MS, ctx.signal, ctx);
  const body = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.code !== 0) throw new Error(body || `${plan.title} provisioning exited ${result.code}`);
  const manifest = commitEnvironmentRequirement(root, plan);
  if (ctx.sessionId) ensureManagedHome(ctx.sessionId, root);
  return {
    output: [body || `${plan.title} ready`, '', 'Managed environment:', JSON.stringify(describeManagedEnvironment(root), null, 2)].join('\n'),
    title: plan.title,
    metadata: { environment: { kind: plan.kind, installed: manifest.installed } },
  };
}

export function executeEnvironmentStatus(root, input) {
  const environment = describeManagedEnvironment(root);
  const commands = environmentCommandStatus(root, input?.commands || []);
  return {
    output: JSON.stringify({ environment, commands }, null, 2),
    title: 'Environment status',
    metadata: { environmentStatus: true },
  };
}
