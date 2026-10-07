# Production operations

This runbook describes the hardened single-host Docker profile. `SECURITY.md` defines the trust boundaries; this file defines the operator actions that preserve them.

## 1. Bootstrap

```bash
npm run prod:env:init
chmod 600 .env
```

`prod:env:init` refuses to overwrite an existing file and generates separate 256-bit provider-encryption and audit/backup-integrity keys, a SearXNG secret, a registration invite code and a metrics token (see §9 for the `/metrics` variable name). Review registration and model-selected web policy before exposure. Production Compose forces the isolation services, external-key requirement, Secure `__Host-` cookies, disabled interactive terminal and absolute persistent paths; the runtime refuses to start when those invariants are weakened.

Keep `.env` outside backups of `/data`, or move the keys into a secret manager and use `Z_AGENT_SECRET_KEY_FILE` / `Z_AGENT_AUDIT_KEY_FILE`. Never commit `.env`.

## 2. Initial local production-style boot

```bash
docker compose build
docker compose up -d
curl -fsS http://127.0.0.1:3000/health/live
curl -fsS http://127.0.0.1:3000/health/ready
```

The default command is the hardened profile: autonomous execution remains in
the networkless executor and terminal, SSH, public web and networked installers
stay disabled. For a trusted single-user host only, opt in explicitly:

```bash
docker compose -f docker-compose.yml -f docker-compose.override.yml -f docker-compose.trusted.yml up -d
```

Public traffic should terminate at the supplied reverse proxy. The public vhost intentionally does not expose `/metrics`.

## 3. Release qualification

Before promoting a model/runtime combination:

```bash
npm run release:check
npm run eval:benchmark -- \
  --manifest evals/production-benchmark.json \
  --model provider/model \
  --baseline evals/production-baseline.json
```

The deterministic smoke proves runtime wiring, not model intelligence. The private real-repository corpus is the release-quality model gate. Maintain pinned repository commits and an external oracle/regression command per task.

CI is the authority for release artifacts: it builds and boots the production topology, records immutable registry digests, emits SBOM/provenance material and publishes those digests (job *Production container contract*). The repository has no Deploy workflow any more (removed in `ccf1525`), so promotion is an operator step: set `Z_AGENT_API_IMAGE` / `Z_AGENT_BROWSER_IMAGE` (and `Z_AGENT_RELEASE_SHA`) to the published digests and run `docker compose up -d --no-build`. Production deployment must not rebuild the application image.

## 4. Backups and restore drills

Keep off-host copies of:

- the SQLite database;
- the workspace volume;
- the provider-encryption primary/rotation keys;
- the separate audit/backup-integrity key.

Create and verify a snapshot:

```bash
npm run db:backup -- /safe/off-host/staging/z-agent.sqlite
Z_AGENT_RESTORE_REQUIRE_MANIFEST=1 npm run db:restore-verify -- /safe/off-host/staging/z-agent.sqlite
```

In the Docker deployment the application image ships only `server/` (not `scripts/`), and the host usually has no Node.js. Run the same tools inside the API container, where `Z_AGENT_DATA_DIR=/data` and the production keys are already present, then copy the snapshot off the host:

```bash
docker compose exec z-agent node server/backup.mjs /data/backups/z-agent.sqlite
docker compose exec -e Z_AGENT_RESTORE_REQUIRE_MANIFEST=1 z-agent node server/restore-verify.mjs /data/backups/z-agent.sqlite
docker compose cp z-agent:/data/backups/z-agent.sqlite ./z-agent.sqlite
docker compose cp z-agent:/data/backups/z-agent.sqlite.manifest.json ./
```

`npm run db:drill`, `prod:env:init` and the `eval:*` scripts need a source checkout. Without a target argument `db:backup` writes to `<data dir>/backups/z-agent-<timestamp>.sqlite`. The `deploy/host/z-agent-backup` helper automates this flow on the reference host (restic over rclone).

The sidecar manifest authenticates size, SHA-256 and schema with the audit key. Restore verification also checks SQLite/foreign-key integrity, schema compatibility, provider-secret decryptability and the HMAC audit chain.

Run a periodic local drill:

```bash
npm run db:drill
```

A successful backup command without a successful restore verification is not a tested disaster-recovery point.

## 5. Provider-encryption key rotation

1. Generate a new 32-byte random key.
2. Move the current primary into `Z_AGENT_SECRET_KEYS_JSON`.
3. Set the new key as `Z_AGENT_SECRET_KEY` (or its file equivalent).
4. Restart through the normal release path.
5. Let normal secret reads/startup rewrap old envelopes onto the new primary.
6. Verify provider access and a restore drill.
7. Remove an old key only after the database and all retained backups that still require it have aged out or been re-encrypted/replaced.

Do not reuse the audit key as the provider-encryption key.

## 6. Audit verification

```bash
npm run audit:verify
```

Audit records are pseudonymized and HMAC-chained. A chain failure is a security/forensics incident: preserve the database and logs before attempting repair.

## 7. Capacity and abuse controls

Tune conservatively for the host:

- `Z_AGENT_MAX_ACTIVE_TURNS` / `Z_AGENT_MAX_ACTIVE_TURNS_PER_OWNER` bound concurrent model work and spend;
- `Z_AGENT_EXECUTOR_MAX_ACTIVE` / `...PER_UID` bound autonomous process concurrency;
- browser worker/pending and egress connection/byte limits bound web-content pressure;
- Docker CPU/memory/PID caps and executor RLIMITs remain the hard lower-level resource controls.

A 429 capacity response is load shedding, not a reason to disable the limits globally.

## 8. Graceful deployment and rollback

SIGTERM puts the API into drain mode: readiness immediately becomes false, new traffic should stop, and active turns receive `Z_AGENT_SHUTDOWN_GRACE_MS` to finish before durable recovery becomes necessary. Compose waits longer than the configured runtime grace.

Before promoting a candidate, compare its `SCHEMA_MIN_READER_VERSION` (`server/native/migrations.mjs`) with the running release; do not promote a schema that would make the previous image unable to read the resulting database. This check is manual — no script in the repository enforces it. A breaking migration requires a maintenance procedure with an explicit data backup/restore and rollback plan.

## 9. Metrics and incident triage

Set `Z_AGENT_METRICS_BEARER_TOKEN` and scrape the private runtime endpoint with `Authorization: Bearer <token>`. The runtime reads this name; `prod:env:init` currently writes its generated token to `Z_AGENT_METRICS_TOKEN`, which is **not** read, so copy the value across (otherwise `/metrics` answers 404). Keep the public proxy rule that blocks `/metrics`. Completed-turn JSONL telemetry intentionally excludes prompt/tool/file bodies.

For an incident, preserve at minimum:

- release SHA and exact image digests;
- `/health/ready` status;
- application logs/request IDs;
- turn telemetry;
- `audit:verify` result;
- an integrity-checked database snapshot + manifest before destructive intervention.

## 10. Non-goals

This profile does not claim protection from a compromised host root/Docker daemon/kernel, container escape vulnerabilities, or hyperscale hostile-tenant scheduling. If those are required, move untrusted execution to a separately administered VM/microVM/cluster boundary rather than weakening the documented assumptions.
