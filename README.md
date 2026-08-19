# Z Agent Native

Standalone web AI-agent platform with the three-panel UX from the original project: projects/sessions on the left, agent chat in the center, and workspace/files/terminal on the right.

**Z Agent Native does not run or proxy OpenCode.** The browser talks to one first-party runtime that owns conversations, the agent loop, tools, questions, permissions, model calls, workspaces, terminal sessions and persistence.

## Architecture

```text
Browser (React)
   │
   ├── REST       auth, sessions, files, models, settings
   ├── SSE        messages, tool state, questions, file events
   └── Socket.IO  interactive terminal
   │
Z Agent Native Runtime
   ├── Agent loop / context manager / subagents
   ├── Questions + automatic tool approval
   ├── Tools: read, list, glob, grep, write, edit, apply_patch,
   │          bash/SSH, webfetch, websearch, todowrite, task
   ├── Workspace + git + file watcher events
   ├── Provider layer (direct API calls)
   └── SQLite + encrypted provider credentials
          │
          ├── OpenAI / OpenAI-compatible
          ├── Anthropic
          └── Google Gemini
```

There is no second agent process, runner HTTP proxy or protocol translation layer between this runtime and the UI.

Detailed internals: [ARCHITECTURE.md](ARCHITECTURE.md). Deployment/security boundary: [SECURITY.md](SECURITY.md).

## What is native

- **Agent turns** are owned by the runtime (`running`, `waiting_user_input`, `completed`, `failed`, `cancelled`). Tool permission gates are approved automatically and do not pause the turn.
- **Questions** suspend the same turn and resume it when the card is answered. No abort/new-message fallback.
- **Tool calls** are first-class persisted parts of assistant messages.
- **Attachments** are first-class chat/workspace objects. Text file contents are not rendered as user prose.
- **Workspace** is the source of truth. File-changing tools emit workspace events immediately; polling remains a fallback.
- **Terminal** opens directly in the session workspace and never receives model-provider secrets in its environment.
- **Model catalog** comes from the same provider registry used for inference. Manual models, discovery patterns, hidden models and custom endpoints are owner-scoped.
- **Streaming** is parsed directly from OpenAI-compatible SSE, Anthropic Messages streaming and Gemini `streamGenerateContent`.
- **Subagent (`task`)** runs a nested model/tool loop for focused read-only investigation; it cannot silently mutate the parent workspace.

## Requirements

- Node.js **24+**
- npm
- Linux/macOS for the full shell/terminal experience
- `git` and `bash`
- `ssh`, `scp`/`rsync` if the agent should work with remote servers

## Local start

```bash
cp .env.example .env
npm ci
npm run build
npm start
```

Open `http://localhost:3000`. The first registered account becomes administrator. Set `Z_AGENT_INVITE_CODE` before exposing registration publicly.

On a non-root bare-metal start, shell and terminal stay disabled unless you explicitly opt into the unsafe single-user fallback described below. **For production with shell/terminal enabled, use the supplied Docker image.**

For frontend development:

```bash
# terminal 1
npm run dev:server

# terminal 2
npm run dev:web
```

Vite proxies `/api`, `/health` and `/socket.io` to the native runtime on port 3000.

## Docker

```bash
cp .env.example .env
docker compose up --build -d
```

Runtime state/secrets are stored in `z-agent-data`; agent files are stored separately in `z-agent-workspaces`. The runtime gives each chat a stable low-privilege Unix UID, so its shell/terminal cannot read `/data` or another chat workspace. When serving through HTTPS, set:

```env
Z_AGENT_SECURE_COOKIES=1
```

## Models

Provider API keys are added from **Settings → Models**. They are stored encrypted with AES-256-GCM. On a single-node installation, a random key is generated at `data/master.key` (0600). For reproducible backups or multiple replicas, provide a stable `Z_AGENT_SECRET_KEY` through the environment/secrets manager.

The provider registry starts empty. Add an owner-scoped channel in Settings and
choose one of the supported protocols: OpenAI-compatible, Anthropic Messages,
or Google Gemini. OpenAI-compatible channels cover services such as OpenAI,
xAI, DeepSeek, Groq, Mistral, OpenRouter and self-hosted gateways when their
base URL and model IDs are configured explicitly.

All configured endpoints are SSRF-filtered and DNS-pinned for the request, so
they cannot target loopback/private/link-local/metadata addresses or swap to
one after validation.

## Web search

`webfetch` works without an external search service for a URL the model already knows. The `websearch` tool uses Brave Search when `BRAVE_SEARCH_API_KEY` is configured.

## Workspace and remote servers

Every real chat has exactly one isolated directory:

```text
workspaces/<session-id>/
```

In Docker each chat also gets a distinct, monotonically allocated Unix UID starting at 20000; identities are never reused after chat deletion. The agent's `bash`, `apply_patch`, interactive terminal and Git status processes run as that UID, not as the runtime process. Commands such as `git clone`, `scp`, `rsync`, package managers and tests therefore create files in the same workspace that the right sidebar shows. The system instruction explicitly requires remote project downloads to target this workspace and to verify the files before claiming success.

## Security model

The runtime is intentionally powerful and fully autonomous: permission-gated tool calls are approved inside the runtime without waiting for a browser confirmation. A model-selected `bash` action can execute real commands and SSH to hosts reachable from the runtime container. Production deployments should therefore:

- use the supplied Docker image for production shell/terminal support;
- mount only the dedicated `/data` and `/workspaces` volumes; never mount the Docker socket or arbitrary host paths;
- keep `/data` private to the runtime; tool processes are setuid to a per-session identity and cannot traverse it or sibling workspaces;
- keep the runtime behind HTTPS and set `Z_AGENT_SECURE_COOKIES=1`;
- set an invite code or put registration behind an external access layer;
- use a secrets manager for `Z_AGENT_SECRET_KEY` and optional search credentials;
- expose only networks, credentials and mounts that the autonomous agent is allowed to use.

Provider API keys are not exposed to the browser, terminal process or tool shell environment. On a non-root bare-metal runtime, shell/terminal tools are disabled by default because secure per-session setuid isolation is unavailable. `Z_AGENT_ALLOW_UNISOLATED_SHELL=1` exists only as an explicit unsafe single-user development fallback.

## Tests

Native runtime tests do not require external model APIs:

```bash
npm run test:native
```

They cover storage, ownership, actions/queue, path/symlink protection, SSRF blocking, file tools, shell secret isolation, patch safety, real SSE parsing for the three provider protocols, retries, and an HTTP smoke flow that boots the standalone runtime and exercises auth/session/workspace APIs.

The React/Vitest suite is available through:

```bash
npm test
npm run typecheck
```

## Runtime data

```text
data/
  z-agent.sqlite
  z-agent.sqlite-wal
  z-agent.sqlite-shm
  master.key

workspaces/
  ses_.../
```

Back up both persistent volumes. Back up the SQLite database **and** the master key (or retain the same `Z_AGENT_SECRET_KEY`) if provider credentials must remain decryptable after restore.

## Security-relevant configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `Z_AGENT_INVITE_CODE` | empty | Required for every account after the bootstrap admin. |
| `Z_AGENT_ALLOW_OPEN_REGISTRATION` | `0` | Explicit opt-in to open registration. Without it and without an invite code, registration is closed. |
| `Z_AGENT_TRUST_PROXY` | `0` | Trust the first `X-Forwarded-For` hop for auth rate limiting. Enable only behind a proxy that rewrites it. |
| `Z_AGENT_ALLOWED_ORIGINS` | empty | Comma-separated browser origins accepted by the terminal websocket when the public origin differs from `Host`. |
| `Z_AGENT_SECURE_COOKIES` | `0` | Set to `1` behind HTTPS. |
| `Z_AGENT_RELAY_URL` | empty | Optional HTTPS relay for provider traffic. The relay sees API keys and prompts, so it stays off unless you operate it. |
| `Z_AGENT_TOOLCHAIN_SHA256` | empty | JSON map of pinned toolchain digests, e.g. `{"java:21":"<sha256>"}`. |
| `Z_AGENT_MAX_STEPS` | derived | Pins the per-turn step budget; otherwise it is derived from task complexity and clamped at 128. |
| `Z_AGENT_MAX_UPLOAD_BYTES` | `262144000` | Maximum size of one uploaded file. |
| `Z_AGENT_GREP_TIMEOUT_MS` | `5000` | Deadline for `grep`; literal and regex scans run in a worker thread and are cancelled at the deadline. |
| `Z_AGENT_DURABLE_JOB_TTL_MS` | `86400000` | After this age a crashed durable turn can be taken over instead of blocking the session. |
| `Z_AGENT_MAX_INFLIGHT_UPLOAD_BYTES` | `536870912` | Maximum aggregate body size of one folder-upload request. |

See `SECURITY.md` for the container, deployment and toolchain hardening notes.
