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
Z Agent Native Runtime (trusted orchestrator)
   ├── Agent loop / context manager / subagents
   ├── Questions + automatic tool approval
   ├── First-party file/git/web tools + provider streaming
   ├── Workspace + watcher + terminal
   └── SQLite + encrypted provider credentials
        │ UDS                         │ UDS
        ▼                             ▼
Networkless Executor             Isolated Browser
(arbitrary code, no /data)       (Chromium, no data/workspace mounts)
        │                             │ internal-only network
        └── shared workspace          ▼
                                  Browser Egress Proxy
                                  (policy + SSRF + DNS pin)

Provider traffic: OpenAI-compatible / Anthropic / Gemini
```

There is no second **agent loop** or protocol-translation daemon between the UI and the native orchestrator. Production does use narrow sibling security services: a networkless arbitrary-code executor and an isolated Chromium service reached over Unix-domain sockets, plus a no-secret browser egress proxy. The browser has no direct Internet/API-network route; the proxy is its only outbound path.

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

Compose starts four services: the trusted API/model orchestrator, a `network_mode: none` executor for autonomous shell/build/test code, an isolated browser controller that launches one unprivileged Chromium worker per chat UID, and a no-secret browser egress proxy. Runtime state/secrets are stored in `z-agent-data`; agent files are stored separately in `z-agent-workspaces`. Compose pins the container paths to `/data` and `/workspaces` even though `.env.example` uses convenient relative paths for bare-metal development. Each chat has a stable low-privilege Unix UID, so autonomous code cannot read `/data` or another chat workspace. When serving through HTTPS, set:

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

In Docker each chat also gets a distinct, monotonically allocated Unix UID starting at 20000; identities are never reused after chat deletion. Autonomous `bash`, `run_tests` and diagnostics execute as that UID inside the sibling **networkless executor container**. Model-selected Git and snapshot operations that can activate repository hooks, clean/process filters, fsmonitor helpers or other external processes cross the same executor boundary; only non-executing Git object plumbing stays in the trusted runtime under the session UID. The interactive human terminal is disabled by the production Compose profile; trusted self-hosted operators may explicitly enable it with `Z_AGENT_TERMINAL_ENABLED=1`. All of them therefore create files in the same workspace that the right sidebar shows, while sibling workspaces remain mode-0700 boundaries. Hardened mode intentionally disables networked dependency installers; bake dependencies into the image/operator workflow instead of giving arbitrary agent code Internet access.

## Security model

Production treats model-selected code as hostile. The **hard egress boundary for autonomous code is the executor container**, not command-text filtering: `bash`, builds, tests and diagnostics are sent over a Unix-domain socket to `z-agent-executor`, which has `network_mode: none`, no `/data` mount, a per-session UID, per-command RLIMITs and Docker CPU/memory/PID caps. A Python/Node program, `/dev/tcp`, obfuscated shell, or compromised build script therefore still has no container network interface.

The `guarded` / `tool-only` shell policies and sensitive-file filters remain defense in depth. Provider keys never enter tool environments. Model-selected `webfetch`, `websearch` and browser access are **off by default** (`Z_AGENT_NETWORK_POLICY=off`). Operators may opt into a hostname allowlist or `public` compatibility mode. Chromium runs in a separate browser container that receives neither `/data`, provider secrets nor workspace mounts. A minimal root controller owns the private UDS only long enough to launch each chat browser worker through `setpriv --clear-groups --no-new-privs` as that chat's dedicated UID; web content therefore does not share the controller identity or another chat's browser identity. The container is attached only to an internal Docker network; a separate no-secret egress proxy is the only route outward and reapplies destination policy, SSRF validation and DNS pinning at the actual upstream connection. Provider API traffic is separate and remains SSRF-filtered/DNS-pinned in the trusted orchestrator.

For production:

- use the supplied Compose topology; do not collapse the executor back into the API container;
- never mount the Docker socket or arbitrary host paths into any service;
- keep model web access `off` unless the task genuinely requires it; prefer an explicit allowlist over `public`;
- keep `/data` private to the trusted runtime and keep `Z_AGENT_EXECUTOR_REQUIRED=1` / `Z_AGENT_BROWSER_REQUIRED=1` so missing isolation fails closed;
- serve through HTTPS with `Z_AGENT_SECURE_COOKIES=1`, close registration with an invite/access layer, and store `Z_AGENT_SECRET_KEY` in a secrets manager;
- keep the interactive terminal disabled in multi-user production (`Z_AGENT_TERMINAL_ENABLED=0`, the Compose default). It is a trusted self-hosted opt-in because its shell lives in the orchestrator container rather than the networkless executor.

On non-root bare metal, autonomous shell falls back only when `Z_AGENT_ALLOW_UNISOLATED_SHELL=1` is explicitly enabled for unsafe single-user development; the interactive terminal additionally requires `Z_AGENT_TERMINAL_ENABLED=1`. See `SECURITY.md` for the exact trust boundaries and residual assumptions.

## Tests

Native runtime tests do not require external model APIs:

```bash
npm run test:native
```

They cover storage, ownership, actions/queue, path/symlink protection, SSRF blocking, file tools, shell secret/egress policy, patch safety, provider streaming/retries, completion verification, durable crash recovery, telemetry, and HTTP runtime flows.

The eval manifest now has an **executable** harness rather than only schema validation:

```bash
npm run eval:validate       # fixture manifest/capability consistency
npm run eval:benchmark:validate  # production real-repo manifest contract
npm run eval:smoke          # real runTurn + tools using the deterministic fixture provider
npm run eval:run -- --model anthropic/your-model-id  # real model, isolated workspaces
# compare a new run against a saved baseline; fail only on >5-point case regressions
npm run eval:run -- --model anthropic/your-model-id --baseline evals/baseline.json --fail-on-regression --regression-tolerance 5
# release benchmark over pinned real repositories (use a private 100–300 case manifest)
npm run eval:benchmark -- --manifest evals/production-benchmark.json --model anthropic/your-model-id
```

The bundled manifest contains **30 executable regression cases** across explore/debug/review/implement plus the deterministic smoke. `eval:run` produces scored JSON reports, can run repository/fixture tasks with file expectations and an external verification command, and can compare case scores with a saved baseline so quality regressions are visible rather than inferred from infrastructure tests. CI runs the deterministic smoke so the complete provider → agent loop → tool → verification path is regression-tested without provider credentials. Real-model baselines remain operator-controlled because provider/model output is stochastic and credentialed.

Browser E2E includes the same deterministic fixture provider and verifies a real UI submission through server/runtime/tool execution back to persisted workspace content. The fixture provider is disabled unless `Z_AGENT_ENABLE_FIXTURE_PROVIDER=1`; never enable it on a production instance. `eval:benchmark` is the release-quality harness for a private corpus of pinned real repositories. Remote sources require a full immutable commit hash; model web access is forced off; setup, agent shell work, oracle and regression commands execute through the networkless executor; repeated runs enforce duration/tool-call budgets and stability. The runner fails closed when the executor socket is missing. `--unsafe-local-executor` exists only for trusted fixture development and is intentionally not a release mode.

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

Back up both persistent volumes **off-host**. The automatic pre-deploy SQLite snapshot is only a short-term rollback aid on the same volume (locally retained for 30 days), not disaster recovery. Back up the SQLite database **and** the master key (or retain the same `Z_AGENT_SECRET_KEY`) if provider credentials must remain decryptable after restore. Schema changes are versioned in `schema_migrations`; each migration declares the oldest schema-aware reader it remains compatible with. Automatic deploy refuses a candidate whose schema would make the currently running release unable to roll back; an incompatible migration is rejected by the automatic workflow and requires a separate operator-controlled maintenance deployment with a data-preservation/rollback plan.

```bash
npm run db:backup -- /path/to/z-agent.sqlite   # online, integrity-checked snapshot
npm run db:migrate                              # explicit migration/quick-check entry point
```

Production deploy takes an integrity-checked online SQLite snapshot before touching the candidate, records the running schema-reader version, builds the candidate, verifies the candidate's minimum rollback-reader contract **before startup**, injects a release SHA, waits on `/health/ready` (DB read/write + compatible schema marker, key, writable/free-space checks on both volumes, executor network-boundary attestation and browser/proxy IPC), verifies the live release SHA, and keeps the previous code/image path available for rollback before pruning stale layers.

## Turn telemetry

Each completed turn appends a privacy-minimized JSONL record to `data/turn-telemetry.jsonl` by default. It contains counts/timings (model calls, tokens when reported, context size, provider fallbacks, tool retries/errors, completion-gate reminders, verification attempts, duration and outcome), but not prompt bodies, tool outputs or file contents. Optional `Z_AGENT_MODEL_PRICING_JSON` supplies per-model token prices for cost estimates without baking volatile vendor pricing into the source. The log rotates at 50 MiB by default.

```bash
npm run telemetry:summary
npm run telemetry:summary -- --last 200
```

Use `Z_AGENT_TELEMETRY_FILE` and `Z_AGENT_TELEMETRY_MAX_BYTES` to relocate/bound it. Per-turn telemetry is also attached to the completed assistant message and emitted as `turn.telemetry`. For scraping, set `Z_AGENT_METRICS_TOKEN`; `/metrics` then exposes low-cardinality Prometheus counters/gauges with no user/session/turn IDs in labels.

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
| `Z_AGENT_NETWORK_POLICY` | `off` | Model-selected external network policy: fail-closed `off`, hostname `allowlist`, or trusted compatibility `public`. Provider API traffic is separate. |
| `Z_AGENT_NETWORK_ALLOWLIST` | empty | Comma-separated host patterns for `allowlist`: exact hostnames are exact; use `*.example.com` to explicitly authorize subdomains. |
| `Z_AGENT_EXECUTOR_REQUIRED` | `1` in Compose | Fail closed instead of executing autonomous shell code in the trusted runtime when the networkless executor is missing. |
| `Z_AGENT_BROWSER_REQUIRED` | `1` in Compose | Fail closed when the isolated Chromium service is missing. |
| `Z_AGENT_TERMINAL_ENABLED` | `0` in Compose | Trusted self-hosted opt-in for the interactive terminal. Keep `0` for multi-user production because the terminal is not the autonomous no-network executor. |
| `Z_AGENT_METRICS_TOKEN` | empty | Enables bearer-protected `/metrics`; empty returns 404. |
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
