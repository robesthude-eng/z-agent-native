import path from 'node:path';

const SENSITIVE_BASENAMES = new Set([
  '.env', '.netrc', '.npmrc', '.pypirc',
  'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519',
  'credentials', 'credentials.json', 'service-account.json',
]);

function normalized(relative) {
  return String(relative || '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
}

export function sensitiveFilePolicy() {
  const value = String(process.env.Z_AGENT_SENSITIVE_FILE_POLICY || 'block').trim().toLowerCase();
  return value === 'allow' ? 'allow' : 'block';
}

export function isSensitiveWorkspacePath(relative) {
  const value = normalized(relative);
  if (!value) return false;
  const base = path.posix.basename(value);
  if (/^\.env\.(?:example|sample|template|dist)$/.test(base)) return false;
  if (SENSITIVE_BASENAMES.has(base)) return true;
  if (base.startsWith('.env.')) return true;
  if (value.includes('/.ssh/') || value.endsWith('/.ssh')) return true;
  if (value.includes('/.aws/credentials') || value.includes('/.config/gcloud/')) return true;
  if (/service[-_]?account.*\.json$/.test(base)) return true;
  if (/(?:^|[-_.])(secret|secrets|credentials?)(?:[-_.]|$)/.test(base) && /\.(?:json|ya?ml|toml|ini|conf|txt)$/.test(base)) return true;
  return false;
}

export function assertAgentReadablePath(relative) {
  if (sensitiveFilePolicy() === 'allow') return;
  if (!isSensitiveWorkspacePath(relative)) return;
  throw Object.assign(new Error(`Access to sensitive workspace file is blocked by Z_AGENT_SENSITIVE_FILE_POLICY: ${relative}`), {
    statusCode: 403,
    code: 'SENSITIVE_FILE_BLOCKED',
  });
}


export function agentNetworkPolicy() {
  const value = String(process.env.Z_AGENT_NETWORK_POLICY || 'off').trim().toLowerCase();
  return ['public', 'allowlist', 'off'].includes(value) ? value : 'off';
}

export function agentNetworkAllowlist() {
  return String(process.env.Z_AGENT_NETWORK_ALLOWLIST || '')
    .split(',')
    .map((item) => item.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, ''))
    .filter(Boolean);
}

function hostnameAllowed(hostname, allowed) {
  const host = String(hostname || '').toLowerCase().replace(/\.+$/, '');
  return allowed.some((entry) => {
    const value = String(entry || '').toLowerCase();
    if (value.startsWith('*.')) {
      const suffix = value.slice(2);
      return Boolean(suffix) && host !== suffix && host.endsWith(`.${suffix}`);
    }
    // Exact hostnames are exact by default. Authorizing a parent domain must
    // not silently authorize every tenant-controlled subdomain below it.
    return host === value;
  });
}

/**
 * Policy gate for model-selected network tools. SSRF validation is separate:
 * this answers whether the agent is allowed to send any request to the public
 * host at all, which is the prompt-injection/data-exfiltration boundary.
 */
export function assertAgentNetworkUrl(value, { tool = 'network tool' } = {}) {
  const policy = agentNetworkPolicy();
  if (policy === 'public') return;
  if (policy === 'off') {
    throw Object.assign(new Error(`${tool} is disabled by Z_AGENT_NETWORK_POLICY=off.`), { statusCode: 403, code: 'AGENT_NETWORK_BLOCKED' });
  }
  let parsed;
  try { parsed = new URL(String(value)); } catch {
    throw Object.assign(new Error(`Invalid URL for ${tool}`), { statusCode: 400, code: 'AGENT_NETWORK_URL_INVALID' });
  }
  const allowed = agentNetworkAllowlist();
  if (!allowed.length || !hostnameAllowed(parsed.hostname, allowed)) {
    throw Object.assign(new Error(`${tool} host is not in Z_AGENT_NETWORK_ALLOWLIST: ${parsed.hostname}`), { statusCode: 403, code: 'AGENT_NETWORK_HOST_BLOCKED' });
  }
}

export function assertAgentNetworkHost(hostname, { tool = 'network tool' } = {}) {
  return assertAgentNetworkUrl(`https://${String(hostname || '')}/`, { tool });
}

export function shellNetworkPolicy() {
  const value = String(process.env.Z_AGENT_SHELL_NETWORK_POLICY || 'guarded').trim().toLowerCase();
  return ['open', 'guarded', 'tool-only'].includes(value) ? value : 'guarded';
}

const DIRECT_NETWORK = /(?:^|[;&|\n]\s*|\b)(?:curl|wget|ssh|scp|sftp|ftp|telnet|nc|ncat|socat)\b/i;
const REMOTE_RSYNC = /\brsync\b[^\n;&|]*(?:\s|^)(?:[^\s:@]+@)?[^\s:]+:/i;
const INLINE_NETWORK_CODE = /\b(?:python3?|node|ruby|perl)\b[^\n]*(?:https?:\/\/|requests\.|urllib|socket\.|fetch\s*\(|https?\.(?:get|request)\s*\()/i;
const PACKAGE_NETWORK = /(?:^|[;&|\n]\s*|\b)(?:npm|npx|pnpm|yarn|bun|pip|pip3|poetry|uv|gem|bundle|cargo|go|mvn|gradle|gradlew)\b/i;
const REMOTE_GIT = /\bgit\s+(?:clone|fetch|pull|push|ls-remote)\b/i;
const SENSITIVE_COMMAND = /(?:^|[\s'"`/])(?:\.env(?:\.[\w.-]+)?|\.netrc|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)|\.ssh(?:\/|\b)|(?:aws\/)?credentials(?:\.json)?|service[-_]?account[^\s'"`]*)/i;

/**
 * Defense-in-depth command guard. Production Docker does not rely on these
 * regexes for containment: autonomous code runs in z-agent-executor with
 * network_mode:none. This layer still blocks obvious risky intent early and
 * protects unsafe/local development fallbacks.
 */
export function assertShellCommandAllowed(command) {
  const policy = shellNetworkPolicy();
  if (policy === 'open') return;
  const text = String(command || '');
  const sensitiveScan = text.replace(/\.env\.(?:example|sample|template|dist)\b/gi, '');

  if (SENSITIVE_COMMAND.test(sensitiveScan)) {
    throw Object.assign(new Error('Shell access to credential-like workspace files is blocked by the agent security policy.'), {
      statusCode: 403,
      code: 'SHELL_SENSITIVE_FILE_BLOCKED',
    });
  }

  if (DIRECT_NETWORK.test(text) || REMOTE_RSYNC.test(text) || INLINE_NETWORK_CODE.test(text)) {
    throw Object.assign(new Error('Direct shell network egress is blocked. Use webfetch/websearch for public reads or explicitly configure Z_AGENT_SHELL_NETWORK_POLICY=open for a trusted single-user deployment.'), {
      statusCode: 403,
      code: 'SHELL_EGRESS_BLOCKED',
    });
  }

  if (policy === 'tool-only' && (PACKAGE_NETWORK.test(text) || REMOTE_GIT.test(text))) {
    throw Object.assign(new Error('This shell command may access the network and is blocked by Z_AGENT_SHELL_NETWORK_POLICY=tool-only. Use managed environment tools or run it outside the autonomous agent boundary.'), {
      statusCode: 403,
      code: 'SHELL_EGRESS_BLOCKED',
    });
  }
}
