# Z Agent Native architecture

Z Agent Native is one application with one trusted server runtime. The browser is a view/controller; it does not own agent state, model credentials, tool execution, or workspace truth.

```text
React browser
  ├─ REST      durable reads/writes
  ├─ SSE       chat/tool/question/permission/workspace events
  └─ Socket.IO interactive terminal
       │
       ▼
Native runtime
  ├─ session + turn state
  ├─ agent loop + context/turn strategy
  ├─ repository intelligence + specialized subagents
  ├─ direct provider streaming
  ├─ tool executor + permission gate
  ├─ question suspension/resume
  ├─ workspace + watcher + terminal
  └─ SQLite persistence + encrypted provider secrets
```

There is no external agent daemon and no protocol adapter between the UI and the agent loop.

## Source of truth

- SQLite owns users, auth sessions, conversations, messages, turns, action idempotency, queue state, questions, permissions, provider keys, manual/hidden models and user preferences.
- The session workspace directory owns project files.
- The runtime owns the live turn controller and emits projections over SSE.
- The model catalog used by the UI is built from the same provider registry used for inference.

## Agent turn

1. The runtime persists exactly one user message with typed parts.
2. It reconstructs coherent model frames from persisted history.
3. Before every provider call, the context manager compacts oversized tool observations and bounds the full frame set while preserving tool-call/result coherence.
4. The selected model is called directly and text deltas are streamed to the UI.
5. Tool calls are persisted as assistant tool parts; risky tools stop at a permission gate.
6. `todowrite` updates the live turn strategy so the original goal and current plan remain pinned in model guidance across long tool loops.
7. On broad/unfamiliar codebases, `repo_map` can provide a bounded structural index before targeted reads.
8. `task` can delegate focused read-only investigation to an `explore`, `debug`, or `review` subagent.
9. `question` suspends the current turn and resumes that same turn with the answer.
10. Tool results are fed back to the same model loop until a final model response or the step limit.
11. Workspace-changing operations mark the turn as needing verification. When executable shell verification is available, the runtime does not accept a final model response until a successful targeted test/build/typecheck/lint/syntax check has happened after the latest change.
12. On runtimes where secure shell execution is unavailable, the hard verification gate is disabled; the model is told to inspect the changed files and report the verification limitation instead of entering an impossible loop.
13. Final turn state is persisted and `session.idle` is emitted.

No question answer is converted into a synthetic user turn. Tool output is never flattened into user prose. Runtime completion-gate reminders are internal turn frames and are not persisted as user-authored chat messages.

## Context manager

The context manager runs on every model step, including nested read-only subagents. It uses a deterministic character budget as a provider-neutral safety bound and applies two layers of compaction:

- individual tool observations are clipped to a configurable maximum while preserving useful head/tail evidence;
- oldest frames are dropped when the total budget is exceeded, while matching assistant tool calls and retained tool results stay coherent.

The live turn strategy is injected separately from conversation history, so the current user goal and `todowrite` plan do not disappear merely because old observations are compacted.

## Repository intelligence

`repo_map` is a trusted, read-only runtime tool intended to replace blind recursive browsing with one bounded high-signal scan. It never executes project code. The mapper skips vendor/generated/cache trees and caps the number and size of source files it inspects.

The map includes:

- language/file distribution and top-level repository areas;
- manifests, package scripts and common configuration/CI files;
- declared/common entrypoint candidates;
- relative-import hubs for JS/TS code;
- a bounded symbol index for common JS/TS, Python, Go and Rust declarations;
- detected tests.

The output is a navigation index, not semantic truth. The parent agent and subagents are instructed to confirm relevant details with `grep`/`read` before making conclusions or edits.

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
- `permission.asked` / `permission.responded`
- `file.edited`
- `file.watcher.updated`

Each session has an in-memory replay ring with monotonic event IDs. Durable UI state can always be reconstructed from REST/SQLite after a restart.

## Workspace and process isolation

Every conversation owns one `workspaces/<session-id>/` directory. In the supplied production container every chat receives a unique monotonically allocated Unix UID. Arbitrary external processes (`bash`, `git apply`, terminal and Git status) run under that UID with a minimal environment. Runtime data and sibling workspaces are not traversable by tool processes.

First-party file tools still execute in the trusted runtime, but every path is resolved through the workspace boundary and symlink/traversal checks. Repository traversal tools skip heavy generated/vendor directories such as `.git`, `node_modules`, build outputs and caches. The `read` tool reads numbered line windows so large text files can be inspected without loading the entire file into memory/context.

## Provider layer

The provider layer talks directly to:

- OpenAI/OpenAI-compatible Chat Completions streaming;
- Anthropic Messages streaming;
- Google Gemini streaming.

Provider adapters normalize text, tool calls, usage and finish reasons into the native agent loop. Provider API keys remain server-side and are encrypted at rest.

## Specialized subagents

`task` creates a nested model loop with a deliberately restricted tool set (`repo_map`, `read`, `list`, `glob`, `grep`). The child cannot mutate the workspace, execute shell commands, use the network, or ask the user.

Each subagent receives an automatic bounded repository snapshot and then follows a role-specific policy:

- `explore` maps architecture, entrypoints, ownership boundaries, data/control flow, tests and local conventions before edits;
- `debug` traces symptoms toward a root cause, separates facts from hypotheses, names alternative explanations and proposes concrete verification targets without pretending it reproduced anything;
- `review` looks for correctness/security/data-loss/concurrency/compatibility regressions and only reports evidence-backed findings ordered by severity.

Subagent context is independently bounded. Reports are returned to the parent turn with role/step metadata; the parent is still responsible for validating important conclusions and for all mutations/verification.

## Coding-agent eval set

`evals/coding-agent.json` contains repository-grounded `explore`, `debug`, and `review` tasks that require concrete paths and implementation concepts. `npm run eval:validate` checks the manifest structure, referenced paths, stable IDs and profile coverage in CI. This is an eval corpus/contract, not a claim of model quality; scored model execution can be layered on top without making CI depend on external provider credentials.
