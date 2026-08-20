# Z Agent Native — production hardening report

This bundle is the production-hardening continuation of the Z Agent Native handoff. The target is a **production-grade single-host Docker/self-hosted deployment** that treats model-selected repository code as untrusted, preserves durable agent state across crashes, fails closed when isolation services are missing, and makes releases observable and rollback-aware.

“10/10” in this report means the documented production profile satisfies the repository's current engineering/security/release checklist. It is not a claim of mathematical perfection, hyperscale architecture, or immunity to a compromised host kernel/root account.

## Security boundary

### Autonomous code plane

- `bash`, tests, builds, diagnostics and process-capable Git operations execute in the sibling `z-agent-executor` service.
- The executor has Docker `network_mode: none`, no `/data` mount and only the workspace + private UDS volumes.
- Every command is launched through `setpriv --clear-groups --no-new-privs` as the chat's monotonic Unix UID, then bounded by `prlimit` and outer Docker PID/CPU/memory caps.
- Executor IPC binds the requested UID/GID to the actual workspace owner. A request cannot combine another session identity with a workspace it does not own.
- The private executor socket directory is root-only; regression coverage proves a session process cannot reconnect to the privileged UDS.
- Production health attests that the executor sees no non-loopback network interface.
- `guarded` / `tool-only` command-text policies and sensitive-file rules remain defense in depth; they are not described as the sandbox.

### Git execution

Repository Git configuration is treated as executable input. Model-selected Git, `git apply`, UI Git operations, and snapshot steps such as `git add` that may trigger hooks, clean/process filters, fsmonitor helpers or other subprocesses cross the networkless executor boundary. Only non-executing Git object plumbing remains in the orchestrator, with hooks/fsmonitor and global/system Git configuration disabled.

### Browser/web-content plane

- Chromium runs in a separate `z-agent-browser` service with no `/data`, no workspace mounts, no provider secrets and no API network.
- A minimal root controller owns only the browser UDS and launches one browser worker per chat through `setpriv --clear-groups --no-new-privs` under that chat's UID.
- The browser has only an internal Docker network. Its sole Internet path is `z-agent-browser-egress`, a non-root/no-secret policy proxy.
- The proxy reapplies `off` / exact-or-explicit-wildcard allowlist / `public` policy, SSRF checks and DNS pinning at the actual HTTP/CONNECT upstream connection.
- Model-selected web access is fail-closed by default (`Z_AGENT_NETWORK_POLICY=off`).
- Service workers and WebSockets from browser content are blocked.

### Trusted orchestrator

The API/orchestrator owns authentication, encrypted provider credentials, SQLite, model calls, first-party path-checked file operations and durable state. Arbitrary autonomous code and Chromium do not run in this trust domain. The interactive human terminal is **disabled in production Compose** and is only an explicit trusted self-hosted opt-in.

### Browser application hardening

The public TLS configuration now supplies HSTS, `nosniff`, strict referrer/permissions policy and same-origin frame policy. Application HTML has a restrictive CSP (`script-src 'self'`, `object-src 'none'`, narrow Sentry telemetry destinations and only same-host websocket sources). Workspace HTML keeps its separate sandboxed-preview CSP and opaque iframe origin.

## Authentication and abuse controls

- Passwords use scrypt; new registrations/password changes require at least 12 characters without locking out legacy-account login.
- Browser session bearer tokens are random and stored only as SHA-256 digests in SQLite; legacy plaintext session rows migrate transparently.
- Bootstrap-admin registration is atomic.
- Registration closes after bootstrap unless an invite/open-registration policy is explicitly configured.
- Login throttling is stored in shared SQLite using hashed IP/account buckets, so multiple replicas cannot bypass an in-memory limiter.
- Unsafe methods require CSRF validation and production cookies support Secure/SameSite/HttpOnly behavior.

## Durability and agent correctness

- Durable turn checkpoints and explicit lifecycle transitions prevent terminal turns from being accidentally resurrected.
- Crash/`SIGKILL` tests cover recovery after a persisted tool checkpoint without replaying a completed mutation and recovery after final-message persistence without a second model call.
- Ambiguous mutation recovery fails closed rather than blindly replaying a possibly completed side effect.
- Completion verification tracks mutation epochs, changed paths and concrete verification evidence; any later mutation makes previous evidence stale.
- Successful `run_tests`/diagnostics count as verification; failed or missing checkers do not.
- Writer subagent mutations propagate to the parent turn and require parent completion verification.
- Provider retry/fallback behavior avoids mixing models after visible output and retries only idempotent transient tool failures.

## Evals and E2E

- The bundled fixture manifest contains 30 executable regression cases: explore=7, debug=7, review=7, implement=8, smoke=1.
- `eval:smoke` drives the real native `runTurn` + workspace tools + verification path through a deterministic fixture provider.
- Real-model evals produce scored JSON reports and can compare per-case results against a saved baseline with regression tolerance.
- `eval:benchmark` supports a private 100–300 task real-repository corpus: immutable git commit/local source, repeated runs, networkless executor, web-off policy, external oracle/regression commands, stability threshold, duration/tool-call budgets and JSON reporting.
- Remote benchmark sources require an immutable full commit hash; release benchmark mode fails closed when the executor socket is unavailable.
- Browser Playwright coverage includes a full submission → runtime → tool mutation → verification → persisted UI/API evidence flow with the deterministic provider.

The repository ships the benchmark **infrastructure and example manifest**, not a pretend 100–300-case real-model score. A release-quality model score still requires operator-selected real repositories/provider credentials and is intentionally separate from deterministic CI smoke.

## Database, readiness and release integrity

- SQLite migrations are explicit, immutable-ID, transactional and forward-only.
- Every migration declares `minReaderVersion`; `SCHEMA_MIN_READER_VERSION` is persisted in `schema_compatibility`.
- Automatic deployment records the running schema reader, builds the candidate, and refuses to start a candidate whose schema would make automatic image rollback unsafe. There is intentionally no bypass flag in the automatic workflow; breaking migrations require a separate maintenance procedure.
- Migration code never lowers a future `PRAGMA user_version`; unknown future schemas fail closed unless they explicitly advertise compatibility.
- Pre-deploy backup refuses missing/empty/corrupt source databases, uses SQLite online `VACUUM INTO`, and verifies `PRAGMA quick_check`.
- Same-volume pre-deploy snapshots are bounded to 30-day local retention and are documented as rollback aids, **not disaster recovery**. Production still requires off-host backup of SQLite plus the master key/stable `Z_AGENT_SECRET_KEY` and workspace data.
- `/health/live` is process liveness only. `/health/ready` checks rollback-only DB write, schema compatibility, secret store, persistent-volume writes, minimum free-space floor, executor IPC + no-network attestation and browser/proxy IPC.
- Public readiness output does not expose raw exception/path details.
- Deploy identity comes from `Z_AGENT_RELEASE_SHA` inside the running container, never from checkout HEAD. The rollback trap is installed before reset/build and stale images are pruned only after candidate readiness.

## Observability and maintenance

- Per-turn telemetry records privacy-minimized model/tool timings and counts, fallbacks, retries, tokens, context size, verification/gate activity, outcome and optional operator-supplied cost estimates without prompt/tool-output/file bodies.
- Bearer-protected `/metrics` exposes low-cardinality Prometheus metrics with no user/session/turn IDs as labels.
- CI generates a CycloneDX npm SBOM.
- Dependabot is configured for npm, GitHub Actions and Docker dependencies.
- Production CI validates Compose, validates the Caddyfile, builds both runtime images, boots the full four-service topology, waits for readiness and verifies the live release SHA before Deploy can run.
- High/critical runtime npm advisories, correctness lint, typecheck, unit tests, build and Playwright E2E are blocking release gates; formatting remains report-only.

## Verification performed in this packaging environment

Passed locally:

- `node --check` across every `server/`, `scripts/` and `tests/` `.mjs` file.
- YAML parse of `docker-compose.yml`, CI, Deploy and Dependabot configuration.
- `bash -n` on the extracted production deploy heredoc.
- `npm run docs:check` — capability documentation matches the runtime registry.
- `npm run eval:validate` — 30 executable cases (explore=7, debug=7, review=7, implement=8, smoke=1).
- `npm run eval:benchmark:validate` — production real-repository benchmark contract valid.
- `npm run eval:smoke` — **100/100**, 1/1 deterministic case through the real native agent/tool/verification path.
- `npm run test:native` — **224 tests: 222 passed, 0 failed, 2 skipped**.

The two skipped native tests are existing platform-conditional branches; no failure is hidden as a skip.

## Packaging-environment limitation

The project requires Node.js 24+, while this packaging host exposes Node.js 22.16.0 and its frontend `node_modules` installation is incomplete. Docker is also unavailable in this host. A direct attempt to bootstrap an isolated Node 24 toolchain could not complete because outbound package/binary download is unavailable from the execution environment.

Therefore this packaging session does **not** claim local execution of Biome, frontend TypeScript/Vitest/Vite, Playwright, Caddy validation inside its official container, or the four-service Docker boot. Those are configured as blocking Node-24/Docker CI release gates and must be green on the actual repository SHA before deployment.

## Residual threat model / non-goals

This design materially isolates untrusted model/repository code, but no single-host application can honestly promise universal “10/10” security. The documented production profile does not claim protection from:

- a compromised host kernel, Docker daemon or root/operator account;
- container/kernel escape vulnerabilities;
- strict per-tenant cgroup fairness or hyperscale scheduling (the executor is a shared bounded service, so hostile compute can still create availability pressure within its outer caps);
- intentional data egress after an operator explicitly enables model web access to a destination allowed by policy;
- disaster recovery without independent off-host backups;
- model-quality guarantees beyond the real-repository benchmark corpus the operator actually runs.

Within those explicit boundaries, the previous application-layer security assumptions have been replaced by enforceable execution/network identities, fail-closed production service requirements, tested recovery invariants and release gates.
