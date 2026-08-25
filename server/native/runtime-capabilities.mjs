import { browserServiceAvailable } from './browser-client.mjs';
import { executorAvailable, executorRequired } from './executor-client.mjs';
import { shellSandboxAvailable } from './sandbox.mjs';
import { terminalEnabled } from './terminal.mjs';
import { availableToolDefinitions } from './tools.mjs';
import {
  agentNetworkAllowlist,
  agentNetworkPolicy,
  sensitiveFilePolicy,
  shellNetworkPolicy,
  shellPrivilegePolicy,
  sshHostAllowlist,
  sshPolicy,
} from './workspace-policy.mjs';

/**
 * Safe, operator-facing capability snapshot. Values describe effective runtime
 * policy; allowlist contents and other configuration secrets are never sent to
 * the browser, only their counts.
 */
export function runtimeCapabilities() {
  const tools = availableToolDefinitions().map((tool) => tool.name).sort();
  const has = (name) => tools.includes(name);
  const executorIsRequired = executorRequired();
  const executorIsReady = executorAvailable();
  const sandboxIsReady = shellSandboxAvailable();
  const webPolicy = agentNetworkPolicy();
  const remotePolicy = sshPolicy();

  return {
    runtime: 'z-agent-native',
    version: '1.0.0',
    capabilities: {
      workspace: { state: 'ready', mode: 'session-isolated' },
      shell: {
        state: has('bash') ? 'ready' : 'disabled',
        mode: executorIsRequired ? 'isolated-executor' : sandboxIsReady ? 'local-sandbox' : 'disabled',
      },
      executor: {
        state: executorIsReady ? 'ready' : executorIsRequired ? 'failed' : 'disabled',
        required: executorIsRequired,
      },
      browser: {
        state: has('browser') ? (browserServiceAvailable() ? 'ready' : 'local-fallback') : 'disabled',
        isolated: browserServiceAvailable(),
      },
      web: {
        state: webPolicy === 'off' ? 'disabled' : 'ready',
        mode: webPolicy,
        allowlistCount: agentNetworkAllowlist().length,
      },
      terminal: {
        state: terminalEnabled() && sandboxIsReady ? 'ready' : 'disabled',
      },
      ssh: {
        state: has('ssh_tool') ? 'ready' : 'disabled',
        mode: remotePolicy,
        allowlistCount: sshHostAllowlist().length,
      },
      installers: { state: has('ensure_environment') ? 'ready' : 'disabled' },
      sudo: { state: shellPrivilegePolicy() === 'sudo' ? 'ready' : 'disabled' },
    },
    policies: {
      web: webPolicy,
      shellNetwork: shellNetworkPolicy(),
      ssh: remotePolicy,
      sensitiveFiles: sensitiveFilePolicy(),
      privilege: shellPrivilegePolicy(),
    },
    tools,
  };
}
