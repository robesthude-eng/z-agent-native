# Z Agent Native architecture

Z Agent Native is one application with one trusted server runtime. The browser is a view/controller; it does not own agent state, model credentials, tool execution, or workspace truth.

```text
React browser
  ├─ REST      durable reads/writes
  ├─ SSE       chat/tool/question/workspace events
  └─ Socket.IO interactive terminal
       │
       ▼
Native runtime (trusted orchestrator)
  ├─ session + explicit turn state machine
  ├─ agent loop + context/turn strategy
  ├─ direct provider streaming
  ├─ first-party file/git/web tool dispatch
  ├─ question suspension/resume
  ├─ workspace + watcher
  ├─ optional trusted human terminal (off in production Compose)
  └─ SQLite persistence + encrypted provider secrets
       │ UDS                         │ UDS
       ▼                             ▼
Networkless executor             Browser service
  arbitrary shell/build/test       root controller: UDS + UID launcher only
  setpriv clear-groups + RLIMITs    per-chat unprivileged Chromium worker
  no /data, network_mode:none       no /data/workspace mounts
  active no-network attestation     internal-only Docker network
                                        │
                                        ▼
                                   Browser egress proxy
                                   policy + SSRF + pinned DNS
```

There is no external **agent** daemon and no protocol adapter between the UI and the agent loop. The executor/browser siblings are deliberately narrow security boundaries: they do not own conversation state, model credentials, planning or persistence.

## Source of truth

- SQLite owns users, auth sessions, conversations, messages, turns, action idempotency, queue state, questions, permissions, provider keys, manual/hidden models and user preferences.
- The session workspace directory owns project files.
- The runtime owns the live turn controller and emits projections over SSE.
- The model catalog used by the UI is built from the same provider registry used for inference.

## Clustering

A single replica keeps turn locks and the SSE ring in process memory. That is the default (`Z_AGENT_CLUSTER` unset or `0`) and needs no extra infrastructure.

Set `Z_AGENT_CLUSTER=1` only when more than one runtime process shares the same SQLite file. Then `server/native/cluster.mjs`:

- registers a heartbeat row per replica (`Z_AGENT_INSTANCE_ID`, or `node-<8 hex>` if empty);
- takes a `turn:<sessionId>` lock before `runTurn`, pulses it every 5s while the turn is running (and on each durable checkpoint), and releases it when the turn goes idle;
- skips durable recovery of a job another replica already holds;
- copies recent SSE frames through a short-lived `cluster_events` table so a browser attached to replica B can catch up with work on replica A.

Lock TTL defaults to 120s (`Z_AGENT_CLUSTER_LOCK_TTL_MS`); the event-bus poll defaults to 250ms (`Z_AGENT_CLUSTER_POLL_MS`). An abandoned lock is stealable after TTL — that is the recovery path if a replica dies between acquire and `notifyTurnIdle`.

Clustering does **not** share the workspace disk. A second replica without a shared `Z_AGENT_WORKSPACES_DIR` (or the `z-agent-workspaces` volume) will lock turns correctly and then fail to see the files. The provider-secret keyring and `Z_AGENT_AUDIT_KEY` must also be the same on every replica, or credentials/audit manifests cannot be authenticated consistently.

## Agent turn

1. The runtime persists exactly one user message with typed parts.
2. It reconstructs coherent model frames from persisted history.
3. Before every provider call, the context manager compacts oversized tool observations and bounds the full frame set while preserving tool-call/result coherence.
4. The selected model is called directly and text deltas are streamed to the UI.
5. Tool calls are persisted as assistant tool parts; the native runtime applies
   its automatic approval policy without waiting for a browser response.
6. `todowrite` updates the live turn strategy so the original goal and current plan remain pinned in model guidance across long tool loops.
7. `question` suspends the current turn and resumes that same turn with the answer.
8. Tool results are fed back to the same model loop until a final model response or the step limit.
9. Workspace-changing operations mark the turn as needing verification. When executable shell verification is available, the runtime does not accept a final model response until a successful targeted test/build/typecheck/lint/syntax check has happened after the latest change.
10. On runtimes where secure shell execution is unavailable, each changed file
    must be read back before completion; the model then reports that executable
    verification was unavailable instead of claiming a test passed.
11. Final turn state is persisted and `session.idle` is emitted.

No question answer is converted into a synthetic user turn. Tool output is never flattened into user prose. Runtime completion-gate reminders are internal turn frames and are not persisted as user-authored chat messages.

## Context manager

The context manager runs on every model step, including nested subagents with profile-specific capabilities. It uses a deterministic character budget as a provider-neutral safety bound and applies two layers of compaction:

- individual tool observations are clipped to a configurable maximum while preserving useful head/tail evidence;
- oldest frames are dropped when the total budget is exceeded, while matching assistant tool calls and retained tool results stay coherent.

The live turn strategy is injected separately from conversation history, so the current user goal and `todowrite` plan do not disappear merely because old observations are compacted.

## Attachments

Attachments are typed message parts containing verified workspace-relative metadata. The visible user text remains separate. The runtime adds attachment paths to model-only context and can load bounded image/PDF data for providers that support multimodal input.

## Realtime protocol

SSE is used for deterministic session events such as:

- `message.updated`
- `message.part.updated`
- `message.part.delta`
- `session.status`
- `session.idle`
- `question.asked` / `question.replied`
- `file.edited`
- `file.watcher.updated`
- `turn.telemetry` (completed-turn counters/timings; no prompt/tool output bodies)

Each session has an in-memory replay ring. Event IDs contain a process epoch and
a per-session sequence, so a reconnect after server restart cannot discard new
low-numbered frames as duplicates. Durable UI state can always be reconstructed
from REST/SQLite after a restart.

## Workspace and process isolation

Every conversation owns one `workspaces/<session-id>/` directory and a unique monotonically allocated Unix UID. In production, arbitrary **autonomous code** (`bash`, tests, builds and diagnostics) is delegated over a Unix-domain socket to `z-agent-executor`; that container mounts the workspaces volume but not `/data`, has `network_mode:none`, attests that no non-loopback interface exists, and launches each command through a fixed trusted privileged environment → `setpriv --clear-groups --no-new-privs` → `prlimit` → clean user environment chain under outer Docker PID/CPU/memory caps. This ordering prevents tool-controlled loader variables such as `LD_PRELOAD` from influencing the privileged launcher. Sibling session roots remain inaccessible because each is mode 0700. Model-selected Git and snapshot operations that can execute repository-controlled hooks, clean/process filters, fsmonitor helpers or other subprocesses cross the same networkless executor boundary; only non-executing object plumbing remains in the orchestrator under the session UID with execution-capable Git features disabled. The interactive terminal is disabled in production Compose because it is a trusted human capability in the orchestrator rather than part of the autonomous no-network execution plane.

First-party file tools still execute in the trusted runtime, but every path is resolved through the workspace boundary and symlink/traversal checks. Repository traversal tools skip heavy generated/vendor directories such as `.git`, `node_modules`, build outputs and caches. The `read` tool reads numbered line windows so large text files can be inspected without loading the entire file into memory/context.

`workspace-policy.mjs` remains a second defense-in-depth layer: `guarded` rejects common direct network clients/credential references and `tool-only` rejects additional package-manager/remote-Git paths, while `read`/`grep` exclude common secret files. These textual policies are **not** the security boundary for arbitrary code; Docker `network_mode:none` on the executor is. Model-selected `webfetch`, `websearch` and browser networking are separately fail-closed by default (`Z_AGENT_NETWORK_POLICY=off`) and may be enabled only with an allowlist or explicit `public` compatibility mode. Chromium runs in its own service with no data/workspace/secret mounts. A minimal root controller owns only the browser UDS and launches each session worker through `setpriv --clear-groups --no-new-privs` as that session's dedicated UID, so separate chats do not share an OS browser identity. Service workers/WebSockets are blocked and HTTP(S) requests are revalidated. It shares no Docker network with the API and has no direct external network. A separate no-secret egress proxy is its only route outward and pins the validated destination address when opening the actual upstream connection.

## Turn telemetry

`turn-telemetry.mjs` records one bounded JSONL summary when a turn finalizes: duration, model/tool counts and latency, provider fallbacks, tool retries, reported token usage, maximum compacted context size, tool errors, completion-gate reminders, verification attempts and final outcome. Shared SQLite turn-capacity leases bound global/per-owner model concurrency and expire after crash; executor/browser/egress layers apply their own lower-level resource budgets. If the operator supplies `Z_AGENT_MODEL_PRICING_JSON`, the record also includes a token-based estimated USD cost; no vendor prices are hard-coded. It does not persist prompt text, tool output or file contents. The same summary is attached to the final assistant message and emitted as `turn.telemetry`; `scripts/summarize-turn-telemetry.mjs` aggregates recent records. Bearer-protected `/metrics` exposes low-cardinality Prometheus aggregates without user/session/turn labels.

## Persistence and readiness

SQLite schema evolution is explicit and versioned in `server/native/migrations.mjs`; released migration IDs are immutable and each migration is transactional. Every migration declares `minReaderVersion`; the release-wide `SCHEMA_MIN_READER_VERSION` is persisted in `schema_compatibility`, older code fails closed on an unknown future schema unless that contract permits it, and migration code never lowers `PRAGMA user_version`. Deploy records the currently running schema reader and rejects a candidate whose minimum compatible reader would make automatic image rollback unsafe; incompatible changes require a maintenance-only deployment procedure. `server/backup.mjs` refuses missing/empty/corrupt source databases, creates an online `VACUUM INTO` snapshot, verifies `PRAGMA quick_check`, and writes an HMAC-authenticated manifest containing size/SHA-256/schema. Restore verification additionally proves foreign keys, secret decryptability and the tamper-evident audit chain.

Production secrets are external-key-first: provider keys use a key-ID/AAD-bound AES-GCM envelope with old-key rewrap support, while a separate audit key authenticates audit events and backup manifests. Production rejects `/data`-resident key fallback.

CI follows build-once/deploy-by-digest: the exact production images are built, boot-tested and then published; Deploy starts those immutable registry digests without a server rebuild and verifies the running image identities. `/health/live` proves only process liveness. `/health/ready` proves a rollback-only database write, schema compatibility, external-key availability, data/workspace volume writes plus a configurable free-space floor, executor IPC plus no-network attestation, and browser/proxy IPC. During SIGTERM drain readiness becomes false immediately while existing turns get a bounded grace period. Public readiness output deliberately omits raw exception/path details.

## Provider layer

The provider layer talks directly to:

- OpenAI/OpenAI-compatible Chat Completions streaming;
- Anthropic Messages streaming;
- Google Gemini streaming.

Provider adapters normalize text, tool calls, usage and finish reasons into the native agent loop. Provider API keys remain server-side and are encrypted at rest.

## Specialized subagents

`task` creates a nested model loop with a profile-specific tool set. `explore`, `debug`, and `review` are read-only and cannot use shell/network tools or ask the user. `implement` is a scoped writer: it may edit the same workspace through the normal sandboxed mutation tools and is required to verify the resulting change. No subagent may recursively delegate or ask the user. Child context is independently bounded.

<!-- BEGIN GENERATED SUBAGENT CAPABILITIES -->
| Profile | Writes workspace | Max steps | Tools |
| --- | --- | ---: | --- |
| `planner` | no | 12 | `repo_map`, `read`, `list`, `glob`, `grep` |
| `explore` | no | 12 | `repo_map`, `read`, `list`, `glob`, `grep` |
| `debug` | no | 14 | `repo_map`, `read`, `list`, `glob`, `grep` |
| `review` | no | 14 | `repo_map`, `read`, `list`, `glob`, `grep` |
| `security` | no | 14 | `repo_map`, `read`, `list`, `glob`, `grep` |
| `tester` | no | 14 | `repo_map`, `read`, `list`, `glob`, `grep` |
| `implement` | yes | 24 | `repo_map`, `read`, `list`, `glob`, `grep`, `write`, `edit`, `apply_patch`, `bash`, `git`, `run_tests`, `diagnostics` |
<!-- END GENERATED SUBAGENT CAPABILITIES -->
