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
- **Subagent (`task`)** runs a nested model/tool loop with profile-specific capabilities. `explore`, `debug`, and `review` are read-only; `implement` may edit the parent workspace and must verify its scoped change.

## Subagent capability matrix

The table below is generated from the same registry the runtime uses. `npm run docs:check` fails CI if it drifts.

<!-- BEGIN GENERATED SUBAGENT CAPABILITIES -->
| Profile | Writes workspace | Max steps | Tools |
| --- | --- | ---: | --- |
| `explore` | no | 12 | `repo_map`, `read`, `list`, `glob`, `grep` |
| `debug` | no | 14 | `repo_map`, `read`, `list`, `glob`, `grep` |
| `review` | no | 14 | `repo_map`, `read`, `list`, `glob`, `grep` |
| `implement` | yes | 24 | `repo_map`, `read`, `list`, `glob`, `grep`, `write`, `edit`, `apply_patch`, `bash`, `git`, `run_tests`, `diagnostics` |
<!-- END GENERATED SUBAGENT CAPABILITIES -->

## Requirements

- Node.js **24+**
- npm
- Linux/macOS for the full shell/terminal experience
- `git` and `bash`
- `ssh`, `scp`/`rsync` only when remote workflows are explicitly permitted by your configured shell/network policy

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

In Docker each chat also gets a distinct, monotonically allocated Unix UID starting at 20000; identities are never reused after chat deletion. The agent's `bash`, `apply_patch`, interactive terminal and Git status processes run as that UID, not as the runtime process. Permitted external processes such as local Git operations, package/build commands and tests therefore create files in the same workspace that the right sidebar shows. Remote Git/SCP/rsync/package-network operations are additionally subject to the configured egress policy. The system instruction explicitly requires remote project downloads to target this workspace and to verify the files before claiming success.

## Security model

The runtime is intentionally powerful and fully autonomous: permission-gated tool calls are approved inside the runtime without waiting for a browser confirmation. `bash` executes real commands, but direct shell egress is **guarded by default**: common network clients and direct references to credential-like workspace files are blocked before process launch. This application-layer policy reduces accidental/prompt-injected exfiltration but is not a kernel firewall; production deployments should therefore:

- use the supplied Docker image for production shell/terminal support;
- mount only the dedicated `/data` and `/workspaces` volumes; never mount the Docker socket or arbitrary host paths;
- keep `/data` private to the runtime; tool processes are setuid to a per-session identity and cannot traverse it or sibling workspaces;
- keep the runtime behind HTTPS and set `Z_AGENT_SECURE_COOKIES=1`;
- set an invite code or put registration behind an external access layer;
- use a secrets manager for `Z_AGENT_SECRET_KEY` and optional search credentials;
- expose only networks, credentials and mounts that the autonomous agent is allowed to use.

Provider API keys are not exposed to the browser, terminal process or tool shell environment. Workspace files matching common credential patterns (`.env`, SSH keys, cloud credential stores, etc.) are also blocked from agent `read`/`grep` and guarded shell access by default. Use `Z_AGENT_SHELL_NETWORK_POLICY=tool-only` for a stricter multi-user shell posture, or `open` only for trusted compatibility workloads. Model-selected `webfetch`/`websearch`/`browser` traffic has a separate `Z_AGENT_NETWORK_POLICY`: set it to `allowlist` with `Z_AGENT_NETWORK_ALLOWLIST=docs.example.com,...`, or `off`, when arbitrary public destinations are not acceptable. On a non-root bare-metal runtime, shell/terminal tools are disabled by default because secure per-session setuid isolation is unavailable. `Z_AGENT_ALLOW_UNISOLATED_SHELL=1` exists only as an explicit unsafe single-user development fallback.

## Tests

Native runtime tests do not require external model APIs:

```bash
npm run test:native
```

They cover storage, ownership, actions/queue, path/symlink protection, SSRF blocking, file tools, shell secret/egress policy, patch safety, provider streaming/retries, completion verification, durable crash recovery, telemetry, and HTTP runtime flows.

The eval manifest now has an **executable** harness rather than only schema validation:

```bash
npm run eval:validate       # manifest/capability consistency
npm run eval:smoke          # real runTurn + tools using the deterministic fixture provider
npm run eval:run -- --model anthropic/your-model-id  # real model, isolated workspaces
# compare a new run against a saved baseline; fail only on >5-point case regressions
npm run eval:run -- --model anthropic/your-model-id --baseline evals/baseline.json --fail-on-regression --regression-tolerance 5
```

The manifest contains **30 executable cases** across explore/debug/review/implement plus the deterministic smoke. `eval:run` produces scored JSON reports, can run repository/fixture tasks with file expectations and an external verification command, and can compare case scores with a saved baseline so quality regressions are visible rather than inferred from infrastructure tests. CI runs the deterministic smoke so the complete provider → agent loop → tool → verification path is regression-tested without provider credentials. Real-model baselines remain operator-controlled because provider/model output is stochastic and credentialed.

Browser E2E includes the same deterministic fixture provider and verifies a real UI submission through server/runtime/tool execution back to persisted workspace content. The fixture provider is disabled unless `Z_AGENT_ENABLE_FIXTURE_PROVIDER=1`; never enable it on a production instance.

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

## Turn telemetry

Each completed turn appends a privacy-minimized JSONL record to `data/turn-telemetry.jsonl` by default. It contains counts/timings (model calls, tokens when reported, context size, provider fallbacks, tool retries/errors, completion-gate reminders, verification attempts, duration and outcome), but not prompt bodies, tool outputs or file contents. Optional `Z_AGENT_MODEL_PRICING_JSON` supplies per-model token prices for cost estimates without baking volatile vendor pricing into the source. The log rotates at 50 MiB by default.

```bash
npm run telemetry:summary
npm run telemetry:summary -- --last 200
```

Use `Z_AGENT_TELEMETRY_FILE` and `Z_AGENT_TELEMETRY_MAX_BYTES` to relocate/bound it. Per-turn telemetry is also attached to the completed assistant message and emitted as `turn.telemetry`.

## Security-relevant configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `Z_AGENT_INVITE_CODE` | empty | Required for every account after the bootstrap admin. |
| `Z_AGENT_ALLOW_OPEN_REGISTRATION` | `0` | Explicit opt-in to open registration. Without it and without an invite code, registration is closed. |
| `Z_AGENT_TRUST_PROXY` | `0` | Trust the first `X-Forwarded-For` hop for auth rate limiting. Enable only behind a proxy that rewrites it. |
| `Z_AGENT_ALLOWED_ORIGINS` | empty | Comma-separated browser origins accepted by the terminal websocket when the public origin differs from `Host`. |
| `Z_AGENT_SECURE_COOKIES` | `0` | Set to `1` behind HTTPS. |
| `Z_AGENT_RELAY_URL` | empty | Optional HTTPS relay for provider traffic. Streaming prefers the direct provider URL and only falls back to the relay. The relay sees API keys and prompts. Serverless relays (Cloudflare Workers) typically cut streams after ~30–100s and cannot carry a 30-minute turn. |
| `Z_AGENT_SHELL_NETWORK_POLICY` | `guarded` | `guarded`, `tool-only`, or `open` application-layer shell egress policy. `tool-only` is the stricter multi-user option; neither mode replaces a network firewall. |
| `Z_AGENT_SENSITIVE_FILE_POLICY` | `block` | Blocks agent content access to common workspace credential files. `allow` is an explicit compatibility escape hatch. |
| `Z_AGENT_NETWORK_POLICY` | `public` | Model-selected external network policy: `public`, hostname `allowlist`, or `off`. Provider API traffic is separate. |
| `Z_AGENT_NETWORK_ALLOWLIST` | empty | Comma-separated hostnames accepted when agent network policy is `allowlist`; subdomains are included. |
| `Z_AGENT_TELEMETRY_FILE` | `data/turn-telemetry.jsonl` | Privacy-minimized completed-turn metrics JSONL. |
| `Z_AGENT_MODEL_PRICING_JSON` | empty | Optional model → USD/1M input/output token map used only for telemetry cost estimates. |
| `Z_AGENT_TOOLCHAIN_SHA256` | empty | JSON map of pinned toolchain digests, e.g. `{"java:21":"<sha256>"}`. |
| `Z_AGENT_MAX_STEPS` | derived | Pins the per-turn step budget; otherwise it is derived from task complexity and clamped at 128. |
| `Z_AGENT_TOOL_TIMEOUT_MS` | `600000` | Default budget for one bash/build inside a turn (10 minutes). |
| `Z_AGENT_PROVIDER_STREAM_IDLE_MS` | `180000` | Abort a model stream only after this much silence, not wall-clock. |
| `Z_AGENT_PROVIDER_STREAM_HARD_MS` | `1800000` | Absolute ceiling for one model stream (30 minutes). |
| `Z_AGENT_CLUSTER_LOCK_TTL_MS` | `120000` | Cluster turn-lock TTL. A running turn renews the lock every 5s. |
| `Z_AGENT_MAX_UPLOAD_BYTES` | `262144000` | Maximum size of one uploaded file. |
| `Z_AGENT_GREP_TIMEOUT_MS` | `5000` | Deadline for `grep`; literal and regex scans run in a worker thread and are cancelled at the deadline. |
| `Z_AGENT_DURABLE_JOB_TTL_MS` | `86400000` | After this age a crashed durable turn can be taken over instead of blocking the session. |
| `Z_AGENT_MAX_INFLIGHT_UPLOAD_BYTES` | `536870912` | Maximum aggregate body size of one folder-upload request. |

See `SECURITY.md` for the container, deployment and toolchain hardening notes.
