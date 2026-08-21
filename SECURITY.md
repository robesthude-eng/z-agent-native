# Security model

Z Agent Native is an autonomous agent execution environment. Tool calls are approved automatically by the runtime, so model-selected processes are treated as untrusted. In the supplied production topology, arbitrary autonomous code crosses a Unix-domain socket into a sibling executor with **Docker `network_mode:none`** and no runtime-secret mount. Command-text filtering is defense in depth; the container/network/filesystem boundary is the security control.

## Runtime secrets

- Provider keys are encrypted with AES-256-GCM before SQLite persistence.
- Provider secrets use an `enc:v2` AES-256-GCM envelope with key ID and AAD binding to owner/provider/field. Production requires an external 256-bit `Z_AGENT_SECRET_KEY` or `Z_AGENT_SECRET_KEY_FILE`; `Z_AGENT_SECRET_KEYS_JSON` supplies old keys only for rotation/rewrap. The runtime-generated `data/master.key` fallback is development-only and is rejected by the supplied production profile.
- A separate external `Z_AGENT_AUDIT_KEY`/`Z_AGENT_AUDIT_KEY_FILE` authenticates the append-only audit chain and backup manifests; do not store it on the same `/data` volume it protects.
- Provider keys and runtime secrets are never injected into tool/terminal environments.
- HTTP 5xx responses return a request ID instead of internal exception details.

## Authentication

- Password hashes are versioned scrypt records with bounded parameters and per-user random salt. Successful login transparently upgrades legacy hashes to the current parameters.
- Login sessions use random HttpOnly cookies; only a SHA-256 digest of the 256-bit bearer token is persisted in SQLite, and legacy plaintext session rows are migrated in place.
- Unsafe HTTP methods require a matching double-submit CSRF token.
- Cookies are SameSite=Lax. Production requires HTTPS/Secure cookies and uses the `__Host-` prefix (root path, no Domain) to resist cookie shadowing/fixation.
- Login/register failures are rate-limited through shared SQLite buckets for both normalized remote address and account identifier, so adding replicas does not multiply the brute-force budget. Bucket keys are one-way hashes, not raw IP/email values.
- New registrations/password changes require at least 12 characters; legacy accounts may still authenticate with their existing password until it is changed. Password changes revoke other login sessions.

## Filesystem boundary

- Every chat has one workspace root.
- Path traversal and symlink escape are rejected before file operations.
- Uploads, downloads, previews and agent file tools all resolve inside that root.
- Runtime data (`/data` in Docker) is separate from agent workspaces.

## External process boundary

Production is split into four responsibilities:

- **`z-agent` trusted orchestrator** — owns auth, provider credentials, SQLite, model calls, first-party path-checked tools and persistence. It starts as container root only to manage stable per-session Unix identities. The interactive terminal is disabled by the production Compose profile and is an explicit trusted self-hosted opt-in.
- **`z-agent-executor` untrusted-code plane** — receives autonomous shell/build/test/diagnostic requests over a Unix-domain socket. It mounts only `/workspaces` plus the socket volume, never `/data`; Docker sets `network_mode:none`, read-only rootfs, `no-new-privileges`, bounded PID/CPU/memory, and the process uses `setpriv --clear-groups --no-new-privs` plus `prlimit` for every command. Production health also attests that the executor sees no non-loopback network interface. Commands run as the requesting session UID and cannot inherit the controller's supplementary groups.
- **`z-agent-browser` web-content plane** — a tiny root controller has no `/data`, workspace, env-file or provider-secret mounts and owns only its private UDS. It launches one persistent Chromium worker per chat using `setpriv --clear-groups --no-new-privs` under that chat's dedicated UID. Web content therefore cannot use the controller identity or a sibling chat browser identity. The container is attached only to an internal Docker network, not the API network and not a direct egress network.
- **`z-agent-browser-egress` policy proxy** — has no data/workspace/secret mounts and is the browser's only bridge from the internal network to Internet egress. It reapplies `off`/allowlist/public policy, SSRF validation and pinned DNS resolution for CONNECT/HTTP upstreams.

Session workspace roots are mode 0700 and UIDs are never reused after chat deletion, so code in one workspace cannot traverse a sibling. `/data` is not present in the executor at all. The executor accepts only workspace paths underneath `/workspaces` and production sets `Z_AGENT_EXECUTOR_REQUIRED=1`, so an unavailable service fails closed rather than silently falling back to local arbitrary-code execution.

Model-selected Git commands, `git apply`, UI Git operations, and snapshot steps such as `git add` that can activate repository hooks, clean/process filters, fsmonitor helpers or other external processes are routed through the networkless executor under the requesting session UID. Only non-executing Git object plumbing remains local, with repository hooks/fsmonitor and global/system Git configuration disabled. The interactive terminal, when explicitly enabled with `Z_AGENT_TERMINAL_ENABLED=1`, is a **trusted human-controlled capability**, not the autonomous no-network execution plane; production Compose keeps it disabled.

Startup performs a real privilege-drop probe; merely running as UID 0 is not treated as proof that UID isolation works. Non-root bare-metal shell/terminal is disabled by default. `Z_AGENT_ALLOW_UNISOLATED_SHELL=1` remains an explicit unsafe development fallback only.

## Network boundary

Configured model endpoints must use HTTPS and, like `webfetch`, are
SSRF-filtered. Loopback, private,
link-local, reserved, metadata-like and unsafe DNS results are rejected. The
validated public address is pinned into the socket connection, including for
streaming provider requests, so DNS cannot change the destination between the
check and connect.

### Agent shell egress and workspace secrets

For production autonomous `bash`, `run_tests` and diagnostics, the hard network rule is simple: the executor container has no Docker network. A model may invoke Python, Node, `/dev/tcp`, a compiler, a malicious test runner or an obfuscated binary; it still has no network interface to use. `guarded` and `tool-only` command policies remain useful pre-launch guardrails but are not trusted as a sandbox.

`Z_AGENT_SENSITIVE_FILE_POLICY=block` prevents first-party `read`/`grep` from exposing common workspace secret material such as `.env`, private SSH keys, `.netrc`, cloud credential stores and service-account/credential files. Templates/examples remain readable. This reduces accidental disclosure in model context; it is independent of the executor's no-network boundary.

Model-selected network tools use a separate policy and are **fail-closed by default**: `Z_AGENT_NETWORK_POLICY=off`. `allowlist` permits only exact configured hosts or explicitly wildcarded `*.domain` subdomains; `public` is an explicit trusted compatibility mode. `ensure_environment` is disabled in hardened production unless an operator explicitly opts back into networked installers; dependency provisioning should normally happen in image/CI/operator workflows.

`webfetch` is GET-only, SSRF-filtered and DNS-pinned. `websearch` uses the same pinned transport: Brave when `BRAVE_SEARCH_API_KEY` is set (`api.search.brave.com` must be permitted), otherwise DuckDuckGo Instant Answer (`api.duckduckgo.com`) and Wikipedia OpenSearch (`en.wikipedia.org`). Browser automation runs in the isolated Chromium service; it receives no workspace/data mounts, disables service workers and WebSockets, and revalidates every HTTP(S) request. The browser itself has no direct egress route. Its configured HTTP proxy resolves and validates the destination again and pins the upstream IP for CONNECT/HTTP, closing the browser's previous DNS-check-to-connect gap at the container boundary. The proxy has no private project/runtime data to disclose.

Provider API calls are separate trusted-orchestrator traffic and remain HTTPS-only, SSRF-filtered and DNS-pinned. If an operator enables agent web access, the model can intentionally transmit text already present in its context to an allowed destination; allowlists are therefore a **data-egress authorization decision**, not just an SSRF setting. Keep agent web access `off` for workloads that require hard no-egress.

## Prompt-injection boundary

Repository files, comments, logs, attachments, webpages and tool results are explicitly treated as **untrusted data** in the parent and subagent system instructions. Instructions embedded in that content do not gain authority over the user's request or runtime policy, and the model is told not to use them to disclose secrets, weaken controls, reach unrelated destinations or escape the delegated scope. Repository build instructions may still be used as evidence when they are relevant to the user's requested task and are independently verified.

Prompt instructions are defense in depth, not a security boundary. A manipulated model can still make unsafe choices, which is why production defaults agent web access to `off` and executes arbitrary autonomous code in the networkless sibling executor. If `allowlist`/`public` networking is enabled, treat every permitted destination as authorized to receive model-selected data.

## Automatic tool approval

Write/edit/patch/bash/webfetch/websearch/environment tool calls do not stop for interactive permission confirmation. The native runtime approves those permission gates immediately so an agent turn can continue without depending on a browser tab or network round-trip.

This does **not** bypass the lower-level security controls: workspace path validation, per-session Unix identities, shell sandbox availability checks, SSRF filtering, provider-secret isolation and other tool-specific validation still apply. User questions are separate from permissions and may still pause a turn when the model genuinely needs information from the user.

## Deployment rules

For production:

1. Use the supplied Compose topology (or preserve equivalent executor/browser isolation); do not collapse autonomous code back into the trusted API process.
2. Keep `Z_AGENT_EXECUTOR_REQUIRED=1`, `Z_AGENT_BROWSER_REQUIRED=1`, `Z_AGENT_TERMINAL_ENABLED=0`, and model web networking `off` unless explicitly needed.
3. Mount `/data` only into the trusted runtime; mount `/workspaces` into the runtime/executor, never into the browser. Never mount Docker socket or arbitrary host roots.
4. Serve through HTTPS and enable secure cookies.
5. Configure an invite code or an external access layer before public exposure.
6. Store the provider-encryption key **and the separate audit/backup-integrity key** outside `/data` in a secrets manager. Use `Z_AGENT_SECRET_KEYS_JSON` only for bounded rotation windows.
7. Treat every enabled tool as autonomously executable by the model; expose only networks, credentials and mounts that the agent is allowed to reach.
8. Back up both runtime data and workspaces off-host. Treat a backup as usable only after `db:restore-verify`/`db:drill` succeeds with the independent production keys.
9. Deploy CI-tested images by immutable registry digest; do not rebuild a release on the production host.

## Container and deployment hardening

- The API service publishes on loopback only (`127.0.0.1:3000` and `127.0.0.1:3002`). Executor/browser expose no host TCP ports; IPC is Unix-socket-only. The browser proxy listens only on an unexposed dedicated Docker network. Public exposure and TLS belong to the reverse proxy.
- Compose explicitly pins `Z_AGENT_DATA_DIR=/data` and `Z_AGENT_WORKSPACES_DIR=/workspaces` so bare-metal relative paths from `.env` cannot bypass persistent volumes.
- `no-new-privileges` is enabled. Each service drops all capabilities and adds back only the minimum it needs: the API needs workspace ownership/identity capabilities; executor/browser controllers need only identity switching and process termination. Untrusted children are launched with supplementary groups cleared.
- `pids_limit`, `mem_limit`, `memswap_limit`, `cpus` and ulimits bound runaway services; the executor additionally applies per-command RLIMITs and global/per-UID concurrency caps. Browser workers/proxy connections and shared model turns also have bounded global/per-owner/session capacity. Caps must fit the host.
- Network recon tooling (`netcat`, `ping`, `dig`, `psql`) is not installed in the runtime image.
- Deployment verifies the server against a pinned host key from the `DEPLOY_SSH_HOST_KEY` secret. `ssh-keyscan` at deploy time is not used, because it trusts whatever answers on the network.
- `Z_AGENT_CLUSTER=1` is off by default. Turn it on only when every replica mounts the same `/data` and `/workspaces` volumes and shares the same provider-encryption keyring **and audit key**. Without a shared disk the lock is global but the files are not.

## Toolchain integrity

- Android command line tools are verified against a SHA-256 pinned in the source.
- Java and Gradle downloads are forced to HTTPS (`curl --proto '=https' --tlsv1.2`) and a non-HTTPS redirect target is refused.
- Publishers host the checksum next to the artifact, so pin the expected digests with `Z_AGENT_TOOLCHAIN_SHA256='{"java:21":"<sha256>","gradle:8.14.5":"<sha256>"}'`. Without a pin the runtime falls back to the published checksum, which only detects corruption in transit.
- Provisioned package specs must be plain `name[extras][==version]` (or `platforms;android-36` style SDK coordinates). VCS, URL and local-path specs are rejected before they reach the installer.

## Network egress

- `Z_AGENT_RELAY_URL` is empty by default. When set it must be an HTTPS host that is not loopback/private, and the operator is warned at startup that the relay observes provider API keys and prompt bodies in clear text.
- `webfetch` and provider requests resolve DNS first, validate every returned address, and then connect to the validated address, so a DNS rebind between check and connect cannot reach loopback, link-local or private ranges.
- Redirects are not followed for agent-initiated fetches.
- Autonomous model shell/build/test traffic is networkless at the executor-container layer. `guarded`/`tool-only` remain defense in depth. Model web tools are `off` by default and must be explicitly authorized with an allowlist or `public` compatibility mode.

## Operations integrity

- SQLite migrations are explicit, transactional, forward-only and recorded in `schema_migrations`; released migration IDs are immutable. Each migration declares its oldest compatible schema reader and the resulting `schema_compatibility` marker advertises that contract. Older code refuses an unknown future schema unless compatibility is explicit, and the migration runner never lowers `PRAGMA user_version`. Automatic deploy compares the candidate minimum reader with the running release and refuses an image-rollback-unsafe migration and routes incompatible changes to a separate operator-controlled maintenance deployment.
- Deploy creates an online SQLite snapshot before candidate code can migrate the database. The sidecar manifest authenticates snapshot name/size/SHA-256/schema with an HMAC under the independent audit key. These same-volume snapshots are bounded to 30-day local retention and are rollback aids, not a substitute for off-host data/workspace/key backups.
- `db:restore-verify` proves SQLite/foreign-key integrity, schema compatibility, provider-secret decryptability and audit-chain integrity; `db:drill` performs an isolated snapshot + verification drill.
- CI follows build-once/deploy-by-digest: production images are tested/booted before publication and deployment consumes the recorded immutable `@sha256:` references instead of rebuilding on the server. Remote GitHub Actions are themselves pinned to full commit SHAs.
- `/health/live` is process-only. `/health/ready` performs a rollback-only DB write probe, checks schema compatibility, external-key state, both persistent-volume writes plus a minimum free-space floor, executor IPC/network attestation and browser/proxy IPC. During graceful shutdown it immediately becomes unready while active turns receive a bounded drain window. Raw readiness exceptions are not returned to unauthenticated health callers.
- `/metrics` is disabled unless `Z_AGENT_METRICS_TOKEN` is set; when enabled it requires a bearer token and exports only low-cardinality aggregate labels. The supplied public Caddy vhost blocks `/metrics` entirely.

## Multi-user exposure

- Registration is fail-closed: after the bootstrap admin exists, a new account requires `Z_AGENT_INVITE_CODE` or an explicit `Z_AGENT_ALLOW_OPEN_REGISTRATION=1`.
- Set `Z_AGENT_TRUST_PROXY=1` only behind a proxy that overwrites `X-Forwarded-For`; otherwise the shared login limiter uses the socket address plus a separate normalized-account bucket.
- Set `Z_AGENT_ALLOWED_ORIGINS` when the public origin differs from the `Host` header, so websocket handshakes are checked against the real origin.
