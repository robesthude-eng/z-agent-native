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
7. `question` suspends the current turn and resumes that same turn with the answer.
8. Tool results are fed back to the same model loop until a final model response or the step limit.
9. Workspace-changing operations mark the turn as needing verification. When executable shell verification is available, the runtime does not accept a final model response until a successful targeted test/build/typecheck/lint/syntax check has happened after the latest change.
10. On runtimes where secure shell execution is unavailable, the hard verification gate is disabled; the model is told to inspect the changed files and report the verification limitation instead of entering an impossible loop.
11. Final turn state is persisted and `session.idle` is emitted.

No question answer is converted into a synthetic user turn. Tool output is never flattened into user prose. Runtime completion-gate reminders are internal turn frames and are not persisted as user-authored chat messages.

## Context manager

The context manager runs on every model step, including nested read-only subagents. It uses a deterministic character budget as a provider-neutral safety bound and applies two layers of compaction:

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

## Subagents

`task` creates a nested model loop with a deliberately restricted tool set (`read`, `list`, `glob`, `grep`). The child cannot mutate the workspace, use the network, or ask the user. Its context is independently bounded, and it is instructed to return a concise evidence-based report with concrete file/line references to the parent turn.
