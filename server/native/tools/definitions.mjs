import { EXTENDED_TOOLCHAIN_KINDS } from '../toolchains.mjs';
import { GIT_ACTIONS } from '../git-tool.mjs';
import { SSH_ACTIONS } from '../ssh-tool.mjs';
import { DIAGNOSTIC_KINDS } from '../diagnostics.mjs';
import { BROWSER_ACTIONS } from '../browser-client.mjs';
import {
  MEDIA_MUTATING_TOOLS, MEDIA_SANDBOXED_TOOLS, MEDIA_TOOL_DEFINITIONS, isMediaTool,
} from '../media.mjs';
import { subagentKinds } from '../subagents.mjs';
import { shellSandboxAvailable } from '../sandbox.mjs';
import { agentNetworkPolicy, shellPrivilegePolicy, sshPolicy } from '../workspace-policy.mjs';

const BASE_ENVIRONMENT_KINDS = ['python', 'java', 'gradle', 'android'];
const ENVIRONMENT_KINDS = [...BASE_ENVIRONMENT_KINDS, ...EXTENDED_TOOLCHAIN_KINDS];

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOL_DEFINITIONS = [
  {
    name: 'read',
    description: 'Read a numbered UTF-8 line window from a workspace file. Supports large text files via offset/limit without loading the whole file.',
    inputSchema: object({ path: { type: 'string', description: 'Relative file path' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 4000 } }, ['path']),
  },
  {
    name: 'list',
    description: 'List files/directories in the current workspace. Heavy generated/vendor directories are skipped.',
    inputSchema: object({ path: { type: 'string', description: 'Relative directory, default .' }, depth: { type: 'integer', minimum: 1, maximum: 6 } }),
  },
  {
    name: 'glob',
    description: 'Find workspace files by a simple glob such as **/*.ts, src/**, *.json. **/ also matches the workspace root.',
    inputSchema: object({ pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern']),
  },
  {
    name: 'grep',
    description: 'Search UTF-8 workspace files for text or a regular expression.',
    inputSchema: object({ query: { type: 'string' }, path: { type: 'string' }, regex: { type: 'boolean' }, maxResults: { type: 'integer', minimum: 1, maximum: 300 } }, ['query']),
  },
  {
    name: 'repo_map',
    description: 'Build a bounded high-signal map of a repository or subtree: languages, manifests/scripts, likely entrypoints, important directories, import hubs, symbols, configs and tests. Use before broad codebase investigation.',
    inputSchema: object({
      path: { type: 'string', description: 'Relative repository/subtree path, default .' },
      maxFiles: { type: 'integer', minimum: 100, maximum: 8000 },
      maxSymbolsPerFile: { type: 'integer', minimum: 0, maximum: 20 },
    }),
  },
  {
    name: 'write',
    description: 'Create or replace a UTF-8 file in the workspace. For a browser page/game the user-visible Preview opens index.html at the workspace root — write the main document there (a single root HTML page or a built dist/index.html is picked up automatically).',
    inputSchema: object({ path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),
  },
  {
    name: 'edit',
    description: 'Replace exact text in a UTF-8 workspace file. Safer than rewriting the whole file.',
    inputSchema: object({ path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' }, all: { type: 'boolean' } }, ['path', 'oldText', 'newText']),
  },
  {
    name: 'apply_patch',
    description: 'Apply a unified diff to files in the current workspace. Paths must be relative and stay inside the workspace.',
    inputSchema: object({ patch: { type: 'string', description: 'Unified diff / git diff text' } }, ['patch']),
  },
  {
    name: 'todowrite',
    description: 'Track the plan for a multi-step task. Keep the list concise and update statuses as work progresses.',
    inputSchema: object({
      todos: {
        type: 'array', maxItems: 30,
        items: object({
          content: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
        }, ['content', 'status']),
      },
    }, ['todos']),
  },
  {
    name: 'task',
    description: 'Delegate focused work to a specialized subagent using the same model. Choose planner for a phased architecture plan before implementation, explore for architecture/navigation, debug for root-cause tracing, review for defect-focused code review, security for vulnerability and hardening audits, tester for coverage and verification plans, or implement to carry out and verify a scoped change. Every role except implement is read-only; only implement may modify files.',
    inputSchema: object({
      agent: { type: 'string', enum: subagentKinds(), description: 'Specialized subagent role; defaults to explore. Only implement may modify files.' },
      description: { type: 'string' },
      prompt: { type: 'string' },
    }, ['prompt']),
  },
  {
    name: 'ensure_environment',
    description: 'Provision a missing development runtime or CLI inside this session without sudo, then keep it on PATH for later bash/terminal calls. Supports Python packages, Java, Gradle, Android SDK, Go, Rust, Node.js, Maven, Flutter, kubectl, Terraform, and checksum-pinned portable binaries.',
    inputSchema: object({
      kind: { type: 'string', enum: ENVIRONMENT_KINDS },
      version: { type: 'string', description: 'Requested tool version/channel. Many toolchains accept latest/stable/lts/current as documented by the tool.' },
      packages: { type: 'array', maxItems: 30, items: { type: 'string' }, description: 'pip package specs for python, or sdkmanager package IDs for android.' },
      acceptLicenses: { type: 'boolean', description: 'For Android SDK packages, explicitly accept Android SDK licenses. The permission dialog will show this value.' },
      name: { type: 'string', description: 'For kind=portable, command name to expose on PATH.' },
      url: { type: 'string', description: 'For kind=portable, official HTTPS download URL.' },
      sha256: { type: 'string', description: 'For kind=portable, expected SHA-256 of the downloaded artifact.' },
      archiveType: { type: 'string', enum: ['raw', 'zip', 'tar.gz', 'tar.xz'], description: 'For kind=portable, downloaded artifact format.' },
      binaryPath: { type: 'string', description: 'For archived kind=portable artifacts, relative path to the executable inside the archive.' },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 1_800_000 },
    }, ['kind']),
  },
  {
    name: 'environment_status',
    description: 'Inspect the managed session environment and check whether named commands are currently available on PATH. Use before provisioning when tool availability is unclear.',
    inputSchema: object({ commands: { type: 'array', maxItems: 40, items: { type: 'string' } } }),
  },
  {
    name: 'bash',
    description: 'Run a shell command in the current workspace. Direct network clients and credential-like files are blocked by the default guarded egress policy; use structured web/environment/git tools where possible.',
    inputSchema: object({ command: { type: 'string' }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 1_800_000 } }, ['command']),
  },
  {
    name: 'ssh_tool',
    description: 'Operate a remote server over SSH: test connectivity, run commands, read/write/patch remote files (with automatic .bak backups), and manage systemd services. Use this for ALL remote SSH work instead of bash. The system ssh/scp binaries cannot run here: agent sessions execute under an isolated numeric UID with no /etc/passwd entry, so OpenSSH aborts with "No user exists for uid <N>". This tool speaks SSH over paramiko and is unaffected. Arguments are passed as structured argv, never as a shell string.',
    inputSchema: object({
      action: { type: 'string', enum: SSH_ACTIONS, description: 'test, exec, read, write, patch, or service.' },
      host: { type: 'string', description: 'Remote host IP or hostname.' },
      user: { type: 'string', description: 'Remote SSH user, e.g. root or casano. Defaults to the configured SSH user or root.' },
      port: { type: 'integer', minimum: 1, maximum: 65535, description: 'SSH port, default 22.' },
      keyPath: { type: 'string', description: 'Workspace-relative path to private key, e.g. .ssh/id_rsa. Defaults to configured session key.' },
      command: { type: 'string', description: 'For action=exec: command to run on remote host.' },
      remotePath: { type: 'string', description: 'For action=read/write/patch: absolute path on remote host.' },
      content: { type: 'string', description: 'For action=write: file content to write.' },
      patch: { type: 'string', description: 'For action=patch: unified diff text to apply on remote host.' },
      service: { type: 'string', description: 'For action=service: systemd service name.' },
      serviceAction: { type: 'string', enum: ['status', 'restart', 'stop', 'start', 'reload', 'journal'], description: 'For action=service: operation.' },
      sudo: { type: 'boolean', description: 'Run command/service with sudo if non-root.' },
      lines: { type: 'integer', minimum: 1, maximum: 500, description: 'For action=service, serviceAction=journal: number of lines.' },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 300_000 },
    }, ['action', 'host']),
  },
  {
    name: 'websearch',
    description: 'Search the public web for developer documentation, APIs, error solutions, packages, and current information.',
    inputSchema: object({ query: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 10 } }, ['query']),
  },
  {
    name: 'webfetch',
    description: 'Fetch the text/HTML/JSON content of a public URL (HTTP/HTTPS only).',
    inputSchema: object({ url: { type: 'string' }, maxChars: { type: 'integer', minimum: 1000, maximum: 200000 } }, ['url']),
  },
  {
    name: 'git',
    description: 'Perform Git operations in the workspace. Supported actions: status, diff, log, show, commit, create_branch, branches.',
    inputSchema: object({
      action: { type: 'string', enum: GIT_ACTIONS },
      message: { type: 'string', description: 'For action=commit: commit message' },
      branch: { type: 'string', description: 'For action=create_branch: branch name' },
      paths: { type: 'array', items: { type: 'string' }, description: 'For commit (files to stage) or diff' },
      count: { type: 'integer', minimum: 1, maximum: 50, description: 'For action=log: number of commits' },
      ref: { type: 'string', description: 'For action=show: commit/tag ref' },
      staged: { type: 'boolean', description: 'For action=diff: show staged changes' },
    }, ['action']),
  },
  {
    name: 'run_tests',
    description: 'Discover and run the workspace test suite (Node, Python, Go, Rust, Java/Gradle, Maven, PHP, Ruby). Returns a structured pass/fail report.',
    inputSchema: object({
      framework: { type: 'string', description: 'Override test framework detection' },
      filter: { type: 'string', description: 'Test name / path filter' },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 1_800_000 },
    }),
  },
  {
    name: 'diagnostics',
    description: 'Run static diagnostics on the workspace (tsc/typecheck, eslint/biome/oxlint, python/flake8/ruff/mypy, cargo check, go vet, golangci-lint, maven/gradle). Returns errors and warnings.',
    inputSchema: object({
      kinds: { type: 'array', items: { type: 'string', enum: DIAGNOSTIC_KINDS } },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 300_000 },
    }),
  },
  {
    name: 'browser',
    description: 'Automate an isolated Chromium browser for the current chat session. Supported actions: open, screenshot, click, type, key, evaluate, content, cookies, wait.',
    inputSchema: object({
      action: { type: 'string', enum: BROWSER_ACTIONS, description: 'Browser action to execute' },
      url: { type: 'string', description: 'For action=open: URL (http/https) or workspace-relative path (e.g. index.html)' },
      selector: { type: 'string', description: 'For click/type/wait: CSS or text selector' },
      text: { type: 'string', description: 'For action=type: text to enter' },
      key: { type: 'string', description: 'For action=key: key name (Enter, Tab, Escape, etc.)' },
      script: { type: 'string', description: 'For action=evaluate: JavaScript expression to run in page context' },
      fullPage: { type: 'boolean', description: 'For action=screenshot: capture full scrollable page' },
      timeoutMs: { type: 'integer', minimum: 500, maximum: 60000, description: 'Timeout in ms' },
    }, ['action']),
  },
  ...MEDIA_TOOL_DEFINITIONS,
];

export const MUTATING_TOOLS = new Set([
  'write', 'edit', 'apply_patch', 'todowrite', 'ensure_environment', 'bash', 'ssh_tool', 'git', 'run_tests', 'diagnostics', 'browser',
  ...MEDIA_MUTATING_TOOLS,
]);

export function mutatesWorkspace(name, input = {}) {
  if (name === 'git') {
    return ['commit', 'create_branch'].includes(String(input?.action || '').toLowerCase());
  }
  if (name === 'browser') {
    return false;
  }
  if (name === 'ssh_tool') {
    return false;
  }
  return MUTATING_TOOLS.has(name);
}

export function requiresPermission(name, input = {}) {
  if (isMediaTool(name)) {
    return MEDIA_MUTATING_TOOLS.has(name);
  }
  if (name === 'write' || name === 'edit' || name === 'apply_patch') {
    return true;
  }
  if (name === 'ensure_environment') {
    return true;
  }
  if (name === 'bash') {
    return true;
  }
  if (name === 'git') {
    const action = String(input?.action || '').toLowerCase();
    return action === 'commit' || action === 'create_branch';
  }
  if (name === 'ssh_tool') {
    const action = String(input?.action || '').toLowerCase();
    const serviceAction = String(input?.serviceAction || '').toLowerCase();
    if (action === 'write' || action === 'patch') return true;
    if (action === 'service' && serviceAction && serviceAction !== 'status' && serviceAction !== 'journal') return true;
    if (action === 'exec' && input?.sudo) return true;
    return false;
  }
  if (name === 'browser') {
    const action = String(input?.action || '').toLowerCase();
    return ['click', 'type', 'key', 'evaluate'].includes(action);
  }
  return false;
}

export function availableToolDefinitions() {
  const allowNetwork = agentNetworkPolicy() !== 'off';
  const allowRemote = sshPolicy() !== 'off';
  const sandboxAvailable = shellSandboxAvailable();

  return TOOL_DEFINITIONS.filter((tool) => {
    if (tool.name === 'websearch' || tool.name === 'webfetch') {
      return allowNetwork;
    }
    if (tool.name === 'ssh_tool') {
      return allowRemote;
    }
    if (['bash', 'apply_patch', 'ensure_environment', 'git', 'run_tests', 'diagnostics', 'browser'].includes(tool.name)) {
      return sandboxAvailable;
    }
    if (isMediaTool(tool.name) && MEDIA_SANDBOXED_TOOLS.has(tool.name)) {
      return sandboxAvailable;
    }
    return true;
  });
}
