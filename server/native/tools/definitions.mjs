import { cloudSandboxConfigured } from '../cloud-sandbox.mjs';
import { BROWSER_ACTIONS } from '../browser-client.mjs';
import { DIAGNOSTIC_KINDS } from '../diagnostics.mjs';
import { executorRequired } from '../executor-client.mjs';
import { GIT_ACTIONS } from '../git-tool.mjs';
import { MEDIA_MUTATING_TOOLS, MEDIA_SANDBOXED_TOOLS, MEDIA_TOOL_DEFINITIONS } from '../media.mjs';
import { shellSandboxAvailable } from '../sandbox.mjs';
import { SSH_ACTIONS, SSH_SERVICE_ACTIONS } from '../ssh-tool.mjs';
import { subagentKinds } from '../subagents.mjs';
import { TEST_FRAMEWORKS } from '../test-runner.mjs';
import { EXTENDED_TOOLCHAIN_KINDS } from '../toolchains.mjs';
import { agentNetworkPolicy, sshPolicy } from '../workspace-policy.mjs';

const BASE_ENVIRONMENT_KINDS = ['python', 'java', 'gradle', 'android'];
const ENVIRONMENT_KINDS = [...BASE_ENVIRONMENT_KINDS, ...EXTENDED_TOOLCHAIN_KINDS];

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOL_DEFINITIONS = [
  {
    name: 'read',
    description:
      'Read a numbered UTF-8 line window from a workspace file. Supports large text files via offset/limit without loading the whole file.',
    inputSchema: object(
      {
        path: { type: 'string', description: 'Relative file path' },
        offset: { type: 'integer', minimum: 0, description: 'First line to return (0-based line offset). Default 0.' },
        limit: { type: 'integer', minimum: 1, maximum: 4000, description: 'How many lines to return. Read only the window you need.' },
      },
      ['path'],
    ),
  },
  {
    name: 'list',
    description: 'List files/directories in the current workspace. Heavy generated/vendor directories are skipped.',
    inputSchema: object({
      path: { type: 'string', description: 'Relative directory, default .' },
      depth: { type: 'integer', minimum: 1, maximum: 6, description: 'How many directory levels to descend. Default 2.' },
    }),
  },
  {
    name: 'glob',
    description: 'Find workspace files by a simple glob such as **/*.ts, src/**, *.json. **/ also matches the workspace root.',
    inputSchema: object(
      {
        pattern: { type: 'string', description: 'Glob such as **/*.ts or src/**/*.css' },
        path: { type: 'string', description: 'Relative directory to search in, default .' },
      },
      ['pattern'],
    ),
  },
  {
    name: 'grep',
    description: 'Search UTF-8 workspace files for text or a regular expression. Returns matching lines as path:line: text.',
    inputSchema: object(
      {
        query: { type: 'string', description: 'Literal text to find, or a JavaScript regular expression when regex=true' },
        path: { type: 'string', description: 'Relative file or directory to search, default .' },
        regex: { type: 'boolean', description: 'Treat query as a regular expression. Default false (literal match).' },
        maxResults: { type: 'integer', minimum: 1, maximum: 300, description: 'Maximum matching lines to return. Default 100.' },
      },
      ['query'],
    ),
  },
  {
    name: 'repo_map',
    description:
      'Build a bounded high-signal map of a repository or subtree: languages, manifests/scripts, likely entrypoints, important directories, import hubs, symbols, configs and tests. Use before broad codebase investigation.',
    inputSchema: object({
      path: { type: 'string', description: 'Relative repository/subtree path, default .' },
      maxFiles: { type: 'integer', minimum: 100, maximum: 8000 },
      maxSymbolsPerFile: { type: 'integer', minimum: 0, maximum: 20 },
    }),
  },
  {
    name: 'write',
    description:
      'Create or replace a UTF-8 file in the workspace. For a browser page/game the user-visible Preview opens index.html at the workspace root — write the main document there (a single root HTML page or a built dist/index.html is picked up automatically).',
    inputSchema: object(
      {
        path: { type: 'string', description: 'Relative file path; missing directories are created' },
        content: { type: 'string', description: 'Complete new file content. Prefer edit for changing part of an existing file.' },
      },
      ['path', 'content'],
    ),
  },
  {
    name: 'edit',
    description:
      'Replace exact text in a UTF-8 workspace file. Safer than rewriting the whole file. The result reports the line number, -/+ line counts and the edited region with line numbers.',
    inputSchema: object(
      {
        path: { type: 'string', description: 'Relative file path' },
        oldText: {
          type: 'string',
          description:
            'Exact existing text to replace, including whitespace and indentation. Include enough surrounding lines to make it unique.',
        },
        newText: { type: 'string', description: 'Replacement text. Empty string deletes oldText.' },
        all: { type: 'boolean', description: 'Replace every occurrence instead of only the first. Default false.' },
      },
      ['path', 'oldText', 'newText'],
    ),
  },
  {
    name: 'apply_patch',
    description: 'Apply a unified diff to files in the current workspace. Paths must be relative and stay inside the workspace.',
    inputSchema: object({ patch: { type: 'string', description: 'Unified diff / git diff text' } }, ['patch']),
  },
  {
    name: 'todowrite',
    description: 'Track the plan for a multi-step task. Keep the list concise and update statuses as work progresses.',
    inputSchema: object(
      {
        todos: {
          type: 'array',
          maxItems: 30,
          items: object(
            {
              content: { type: 'string', description: 'Short task description' },
              status: {
                type: 'string',
                enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                description: 'Keep exactly one item in_progress while working',
              },
              priority: { type: 'string', enum: ['low', 'medium', 'high'] },
            },
            ['content', 'status'],
          ),
        },
      },
      ['todos'],
    ),
  },
  {
    // The runtime has always implemented this tool end to end (dispatcher,
    // turn suspension, SSE `question.asked`, durable recovery and the UI card),
    // and the system prompt instructs the model to use it -- but it was missing
    // from this list, so its schema never reached the provider and no real
    // model could ever call it. Only the in-repo fixture provider, which names
    // tools directly, exercised the path.
    name: 'question',
    description:
      'Ask the user a blocking question when a decision genuinely requires them. The current turn suspends and resumes with the answer, so never ask the user to send a separate chat message instead.',
    inputSchema: object(
      {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          items: object(
            {
              question: { type: 'string', description: 'The question to put to the user' },
              header: { type: 'string', description: 'Short label shown as the question heading' },
              options: {
                type: 'array',
                maxItems: 8,
                items: object({ label: { type: 'string' }, description: { type: 'string' } }, ['label']),
                description: 'Suggested answers the user can pick in one click',
              },
              allowCustomResponse: { type: 'boolean', description: 'Allow a free-form answer alongside the options. Defaults to true.' },
            },
            ['question'],
          ),
        },
      },
      ['questions'],
    ),
  },
  {
    name: 'task',
    description:
      'Delegate focused work to a specialized subagent using the same model. Choose planner for a phased architecture plan before implementation, explore for architecture/navigation, debug for root-cause tracing, review for defect-focused code review, security for vulnerability and hardening audits, tester for coverage and verification plans, or implement to carry out and verify a scoped change. Every role except implement is read-only; only implement may modify files.',
    inputSchema: object(
      {
        agent: {
          type: 'string',
          enum: subagentKinds(),
          description: 'Specialized subagent role; defaults to explore. Only implement may modify files.',
        },
        description: { type: 'string' },
        prompt: { type: 'string' },
      },
      ['prompt'],
    ),
  },
  {
    name: 'council',
    description:
      'Poll 2-3 independent models (or perspectives: pragmatist, skeptic, maintainer) on a hard decision and get votes, dissent and risks back. Slow and costly; use at most twice per task and only for genuine forks (architecture/data-model choice, irreversible action, expensive ambiguity). Not for routine work. Provide 2-5 concrete options and a compact context.',
    inputSchema: object(
      {
        question: { type: 'string', description: 'The decision to make, one or two sentences' },
        options: {
          type: 'array',
          minItems: 2,
          maxItems: 5,
          items: { type: 'string' },
          description: 'Concrete mutually exclusive options; they are lettered A, B, C…',
        },
        context: { type: 'string', description: 'Compact facts the decision depends on (constraints, relevant code, trade-offs)' },
      },
      ['question', 'options'],
    ),
  },
  {
    name: 'ensure_environment',
    description:
      'Provision a missing development runtime or CLI inside this session without sudo, then keep it on PATH for later bash/terminal calls. Supports Python packages, Java, Gradle, Android SDK, Go, Rust, Node.js, Maven, Flutter, kubectl, Terraform, and checksum-pinned portable binaries.',
    inputSchema: object(
      {
        kind: { type: 'string', enum: ENVIRONMENT_KINDS },
        version: {
          type: 'string',
          description: 'Requested tool version/channel. Many toolchains accept latest/stable/lts/current as documented by the tool.',
        },
        packages: {
          type: 'array',
          maxItems: 30,
          items: { type: 'string' },
          description: 'pip package specs for python, or sdkmanager package IDs for android.',
        },
        acceptLicenses: {
          type: 'boolean',
          description: 'For Android SDK packages, explicitly accept Android SDK licenses. The permission dialog will show this value.',
        },
        name: { type: 'string', description: 'For kind=portable, command name to expose on PATH.' },
        url: { type: 'string', description: 'For kind=portable, official HTTPS download URL.' },
        sha256: { type: 'string', description: 'For kind=portable, expected SHA-256 of the downloaded artifact.' },
        archiveType: {
          type: 'string',
          enum: ['raw', 'zip', 'tar.gz', 'tar.xz'],
          description: 'For kind=portable, downloaded artifact format.',
        },
        binaryPath: {
          type: 'string',
          description: 'For archived kind=portable artifacts, relative path to the executable inside the archive.',
        },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 1_800_000 },
      },
      ['kind'],
    ),
  },
  {
    name: 'environment_status',
    description:
      'Inspect the managed session environment and check whether named commands are currently available on PATH. Use before provisioning when tool availability is unclear.',
    inputSchema: object({ commands: { type: 'array', maxItems: 40, items: { type: 'string' } } }),
  },
  {
    name: 'bash',
    description:
      'Run a shell command in the current workspace. Direct network clients and credential-like files are blocked by the default guarded egress policy; use structured web/environment/git tools where possible.',
    inputSchema: object(
      {
        command: {
          type: 'string',
          description:
            'Shell command run with bash in the workspace root. Output is truncated when very long; redirect bulky output to a file and inspect it with grep/read.',
        },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 1_800_000, description: 'Timeout in ms. Default 600000 (10 min).' },
      },
      ['command'],
    ),
  },
  {
    name: 'ssh_tool',
    description:
      'Operate a remote server over SSH: test connectivity, run commands, read/write/patch remote files (with automatic .bak backups), and manage systemd services. Use this for ALL remote SSH work instead of bash. The system ssh/scp binaries cannot run here: agent sessions execute under an isolated numeric UID with no /etc/passwd entry, so OpenSSH aborts with "No user exists for uid <N>". This tool speaks SSH over paramiko and is unaffected. Arguments are passed as structured argv, never as a shell string.',
    inputSchema: object(
      {
        action: { type: 'string', enum: SSH_ACTIONS, description: 'test, exec, read, write, patch, or service.' },
        host: { type: 'string', description: 'Remote host IP or hostname.' },
        user: { type: 'string', description: 'Remote SSH user. Defaults to root.' },
        port: { type: 'integer', minimum: 1, maximum: 65535, description: 'SSH port, default 22.' },
        password: {
          type: 'string',
          description: 'SSH password supplied by the user, if key authentication is unavailable. Never invent a password.',
        },
        key: { type: 'string', description: 'Workspace-relative path to the private key, e.g. .ssh/id_ed25519.' },
        keyPath: { type: 'string', description: 'Alias for key.' },
        command: { type: 'string', description: 'For action=exec: command to run on remote host.' },
        path: { type: 'string', description: 'For action=read/write/patch: path on the remote host.' },
        remotePath: { type: 'string', description: 'Alias for path.' },
        offset: { type: 'integer', minimum: 1, description: 'For read: first line, starting at 1.' },
        limit: { type: 'integer', minimum: 1, maximum: 4000, description: 'For read: number of lines.' },
        content: { type: 'string', description: 'For action=write: file content to write.' },
        oldText: { type: 'string', description: 'For patch: exact non-empty text to replace once.' },
        newText: { type: 'string', description: 'For patch: replacement text; empty string deletes oldText.' },
        name: { type: 'string', description: 'For action=service: systemd service name.' },
        service: { type: 'string', description: 'Alias for name.' },
        serviceAction: {
          type: 'string',
          enum: [...SSH_SERVICE_ACTIONS, 'journal'],
          description: 'For service: operation; journal is an alias for logs.',
        },
        sudo: { type: 'boolean', description: 'Run command/service with sudo if non-root.' },
        lines: { type: 'integer', minimum: 1, maximum: 500, description: 'For service logs: number of lines, default 50.' },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 300_000 },
      },
      ['action', 'host'],
    ),
  },
  {
    name: 'websearch',
    description: 'Search the public web for developer documentation, APIs, error solutions, packages, and current information.',
    inputSchema: object(
      {
        query: { type: 'string', description: 'Search query' },
        count: { type: 'integer', minimum: 1, maximum: 10, description: 'Number of results. Default 5.' },
      },
      ['query'],
    ),
  },
  {
    name: 'cloud_sandbox',
    description:
      'Run a shell command on a powerful remote cloud machine (Daytona, default 4 vCPU / 8 GB RAM, Linux with bash, git, Python and Node) against a synced copy of this workspace. Use it for heavy builds, test suites, compilation or data processing that are too slow or memory-hungry for local bash. Local workspace changes are uploaded before the command and files created/changed/deleted remotely are synced back after it. Not synced: node_modules, .venv/venv, __pycache__, .gradle, .next, .cache, .m2 — install dependencies inside the sandbox (they persist there between calls of this chat). The machine persists per chat and auto-stops after idle. nproc and free report the physical host (dozens of cores), not your allocation: size parallelism (make -j, gradle workers) to the vCPU count shown in the result footer. Internet from the sandbox may be limited to package registries and GitHub. action=status shows the machine, action=destroy deletes it.',
    inputSchema: object(
      {
        action: { type: 'string', enum: ['run', 'status', 'destroy'], description: 'Default run.' },
        command: { type: 'string', description: 'Bash command to run in the workspace copy (required for run).' },
        timeoutSec: { type: 'integer', minimum: 10, maximum: 3600, description: 'Command timeout in seconds. Default 600.' },
        cpu: { type: 'integer', minimum: 1, maximum: 10, description: 'vCPUs, applied only when the machine is first created.' },
        memory: { type: 'integer', minimum: 1, maximum: 10, description: 'RAM in GB, applied only when the machine is first created.' },
      },
      [],
    ),
  },
  {
    name: 'webfetch',
    description:
      'Fetch a public URL (HTTP/HTTPS only). HTML pages come back as readable text (title, headings, paragraphs, lists, tables, code, links as [text](url)); JSON and plain text are returned as-is. Use format="html" only when you need the raw markup.',
    inputSchema: object(
      {
        url: { type: 'string', description: 'Absolute http(s) URL' },
        maxChars: { type: 'integer', minimum: 1000, maximum: 200000, description: 'Maximum characters of extracted text to return.' },
        format: {
          type: 'string',
          enum: ['text', 'html'],
          description: 'text (default): readable text extracted from HTML; html: raw markup.',
        },
      },
      ['url'],
    ),
  },
  {
    name: 'git',
    description: 'Perform Git operations in the workspace: status, diff, log, blame, show, commit, create_branch, branches.',
    inputSchema: object(
      {
        action: { type: 'string', enum: GIT_ACTIONS },
        message: { type: 'string', description: 'For action=commit: commit message' },
        branch: { type: 'string', description: 'For action=create_branch: branch name' },
        paths: { type: 'array', items: { type: 'string' }, description: 'For commit (files to stage) or diff' },
        count: { type: 'integer', minimum: 1, maximum: 50, description: 'For action=log: number of commits' },
        ref: { type: 'string', description: 'For action=show: commit/tag ref' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'For log: maximum commits; alias count is also supported.' },
        rev: { type: 'string', description: 'Revision for log, show or diff; alias ref is also supported.' },
        stat: { type: 'boolean', description: 'For diff: show a change summary.' },
        startLine: { type: 'integer', minimum: 1, description: 'For blame: first line.' },
        endLine: { type: 'integer', minimum: 1, description: 'For blame: last line.' },
        staged: { type: 'boolean', description: 'For action=diff: show staged changes' },
      },
      ['action'],
    ),
  },
  {
    name: 'run_tests',
    description:
      'Discover and run the workspace test suite (Node, Python, Go, Rust, Java/Gradle, Maven, PHP, Ruby). Returns a structured pass/fail report.',
    inputSchema: object({
      framework: { type: 'string', enum: TEST_FRAMEWORKS, description: 'Override test framework detection.' },
      command: { type: 'string', description: 'Explicit test command. Takes precedence over automatic detection.' },
      filter: { type: 'string', description: 'Test name / path filter' },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 1_800_000 },
    }),
  },
  {
    name: 'diagnostics',
    description:
      'Run configured typecheck/lint scripts or detected TypeScript, Go, Rust, mypy, Biome, ESLint and Ruff checks. An explicit command can select another checker.',
    inputSchema: object({
      kinds: { type: 'array', items: { type: 'string', enum: DIAGNOSTIC_KINDS } },
      kind: { type: 'string', enum: DIAGNOSTIC_KINDS, description: 'Legacy single-kind alternative to kinds.' },
      command: { type: 'string', description: 'Explicit diagnostic command instead of detection.' },
      timeoutMs: { type: 'integer', minimum: 1000, maximum: 300_000 },
    }),
  },
  {
    name: 'browser',
    description:
      'Automate an isolated Chromium browser for the current chat session. Actions: open (load a URL or workspace file), snapshot (page text and interactive elements), click (selector or visible text), fill (set an input value at once), type (type value key by key; use when fill is reset by the page), press (a key such as Enter, into selector or the focused element), wait (for selector to become visible, or timeoutMs), screenshot (saved into the workspace and shown to you as an image next message; width=390 for a phone layout), console (page console and failed requests), close. fill/type report how many characters the field actually holds afterwards.',
    inputSchema: object(
      {
        action: { type: 'string', enum: [...BROWSER_ACTIONS, 'screenshot'], description: 'Browser action to execute' },
        url: {
          type: 'string',
          description:
            'For action=open: URL (http/https) or workspace-relative path (e.g. index.html). For action=screenshot: optional; omit it to capture the page that is already open.',
        },
        selector: { type: 'string', description: 'For click/fill/type/press/wait: CSS selector of the element' },
        text: { type: 'string', description: 'For click/wait without selector: visible text of the element' },
        value: { type: 'string', description: 'For fill/type: the text to enter into the field' },
        key: { type: 'string', description: 'For action=press: key name (Enter, Tab, Escape, ArrowDown, a, …)' },
        fullPage: {
          type: 'boolean',
          description: 'For action=screenshot: capture the full scrollable page (default true). Set false to capture only the viewport.',
        },
        width: {
          type: 'integer',
          minimum: 200,
          maximum: 4000,
          description: 'For action=screenshot: viewport width in px (default 1280). Use 390 to check a phone layout.',
        },
        height: {
          type: 'integer',
          minimum: 200,
          maximum: 8000,
          description: 'For action=screenshot: viewport height in px (default 1600).',
        },
        path: {
          type: 'string',
          description:
            'For action=screenshot: optional workspace-relative output file (.png or .jpg). Defaults to .screenshots/screenshot-<time>.png',
        },
        timeoutMs: { type: 'integer', minimum: 500, maximum: 60000, description: 'Timeout in ms' },
      },
      ['action'],
    ),
  },
  {
    name: 'visual_check',
    description:
      'Look at a web page/UI the way a user sees it: opens a workspace HTML file or URL in the browser, takes full-page screenshots at desktop (1366px) and phone (390px) widths, collects console/network errors and attaches both images to you. Use after building or changing any page, app UI, layout or styles, then fix what looks wrong and re-check.',
    inputSchema: object({
      url: {
        type: 'string',
        description: 'Workspace-relative HTML path (default index.html) or an http(s) URL, e.g. a local dev server http://127.0.0.1:5173',
      },
      viewports: {
        type: 'array',
        items: { type: 'string', enum: ['desktop', 'mobile'] },
        description: 'Subset of viewports; default both',
      },
      fullPage: { type: 'boolean', description: 'Capture the whole scrollable page (default true)' },
      waitMs: { type: 'integer', minimum: 0, maximum: 10000, description: 'Extra wait after load for animations/data' },
    }),
  },
  {
    name: 'background',
    description:
      'Run long commands (builds, installs, training, big downloads, test suites >2 min, servers) in the background without hitting the tool timeout. action=start returns a job id immediately; the job keeps running after the turn ends. action=status/logs shows progress and the log tail, action=wait blocks until it finishes (up to timeoutSec), action=kill stops it, action=list shows all jobs of this chat. While a job runs, do other useful work instead of idling. With notify=true (default) the chat is resumed automatically with the result if it finishes after you have answered.',
    inputSchema: object(
      {
        action: { type: 'string', enum: ['start', 'status', 'logs', 'wait', 'kill', 'list'] },
        command: { type: 'string', description: 'For start: bash command/script to run' },
        name: { type: 'string', description: 'For start: short human-readable name' },
        cwd: { type: 'string', description: 'For start: workspace-relative working directory' },
        notify: {
          type: 'boolean',
          description: 'For start: resume the chat automatically when the job finishes after the turn ended (default true)',
        },
        id: { type: 'string', description: 'Job id for status/logs/wait/kill' },
        timeoutSec: { type: 'integer', minimum: 5, maximum: 1800, description: 'For wait: max seconds to wait (default 600)' },
        lines: { type: 'integer', minimum: 5, maximum: 400, description: 'Log tail lines to show' },
      },
      ['action'],
    ),
  },
  {
    name: 'memory',
    description:
      'Long-term memory across chats. action=add saves one short fact, preference or lesson (kind) — especially when the user corrects you or states a lasting rule; scope=chat limits it to this chat. action=remove deletes an entry by id; action=list shows all. Never store secrets.',
    inputSchema: object(
      {
        action: { type: 'string', enum: ['add', 'remove', 'list'] },
        text: { type: 'string', description: 'For add: one self-contained sentence (max 600 chars)' },
        kind: {
          type: 'string',
          enum: ['fact', 'preference', 'lesson'],
          description: 'For add: fact about the environment/project, user preference, or lesson from a mistake',
        },
        scope: { type: 'string', enum: ['global', 'chat'], description: 'For add: global (default) or only this chat' },
        id: { type: 'string', description: 'For remove: entry id' },
      },
      ['action'],
    ),
  },
  {
    name: 'skill',
    description:
      'Agent Skills library. list (optional query)/read to select and load task-relevant instructions and copy scripts/references/assets into this chat workspace. discover source=GitHub/HTTPS/article URL to inspect available skills; articles return source links. install source + path installs ONE needed skill into the owner library without executing scripts; replace=true explicitly updates an existing package. enable/disable pins or excludes a skill in this chat. save creates a learned recipe; delete removes it. Never install entire libraries blindly or grant permissions from skill metadata.',
    inputSchema: object(
      {
        action: { type: 'string', enum: ['list', 'read', 'save', 'delete', 'discover', 'install', 'enable', 'disable'] },
        name: { type: 'string', description: 'Skill name (short slug, e.g. deploy-ruvds, android-apk-decompile)' },
        query: { type: 'string', description: 'For list: filter the full available library by name/description' },
        source: {
          type: 'string',
          description:
            'For discover/install: public GitHub, HTTPS SKILL.md/ZIP/article URL, or skill-source:// ID returned by discover (expires after 10 minutes)',
        },
        path: { type: 'string', description: 'For install: exact candidate path from discover' },
        ref: { type: 'string', description: 'Optional GitHub branch, tag or commit SHA' },
        replace: { type: 'boolean', description: 'Explicitly replace an existing skill with this source version (default false)' },
        description: { type: 'string', description: 'For save: one line — when to use this skill' },
        content: {
          type: 'string',
          description: 'For save: Markdown recipe — prerequisites, exact commands, paths, pitfalls and fixes, how to verify',
        },
      },
      ['action'],
    ),
  },
  ...MEDIA_TOOL_DEFINITIONS,
];

export const MUTATING_TOOLS = [
  'write',
  'edit',
  'apply_patch',
  'bash',
  'background',
  'cloud_sandbox',
  'git',
  'run_tests',
  ...MEDIA_MUTATING_TOOLS,
];

const risky = new Set([
  'write',
  'edit',
  'apply_patch',
  'ensure_environment',
  'bash',
  'webfetch',
  'websearch',
  'git',
  'run_tests',
  'diagnostics',
  'browser',
  'ssh_tool',
  'cloud_sandbox',
  'background',
  'visual_check',
  'generate_image',
  'generate_speech',
  'render_document',
  'render_video',
  'convert_media',
  'media_info',
  'view_media',
]);

export function requiresPermission(name) {
  return risky.has(String(name).toLowerCase());
}

export function mutatesWorkspace(name) {
  const tool = String(name).toLowerCase();
  return (
    ['write', 'edit', 'apply_patch', 'bash', 'background', 'cloud_sandbox', 'git', 'run_tests'].includes(tool) ||
    MEDIA_MUTATING_TOOLS.includes(tool)
  );
}

const SANDBOXED_TOOLS = [
  'bash',
  'background',
  'visual_check',
  'apply_patch',
  'ensure_environment',
  'git',
  'run_tests',
  'diagnostics',
  'browser',
  'ssh_tool',
  ...MEDIA_SANDBOXED_TOOLS,
];

export function availableToolDefinitions() {
  let tools = shellSandboxAvailable() ? TOOL_DEFINITIONS : TOOL_DEFINITIONS.filter((tool) => !SANDBOXED_TOOLS.includes(tool.name));
  if (agentNetworkPolicy() === 'off') tools = tools.filter((tool) => !['webfetch', 'websearch'].includes(tool.name));
  if (sshPolicy() === 'off') tools = tools.filter((tool) => tool.name !== 'ssh_tool');
  if (!cloudSandboxConfigured()) tools = tools.filter((tool) => tool.name !== 'cloud_sandbox');
  if (agentNetworkPolicy() !== 'public' || (executorRequired() && process.env.Z_AGENT_ALLOW_NETWORKED_INSTALLERS !== '1')) {
    tools = tools.filter((tool) => tool.name !== 'ensure_environment');
  }
  return tools;
}
