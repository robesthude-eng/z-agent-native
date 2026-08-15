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
  ├─ agent loop + context reconstruction
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
2. It reconstructs coherent model frames from persisted history and trims them to the configured context budget.
3. It calls the selected model provider directly and streams text deltas to the UI.
4. Tool calls are persisted as assistant tool parts.
5. Risky tools stop at a permission gate.
6. `question` suspends the current turn and resumes that same turn with the answer.
7. Tool results are fed back to the same model loop until a final model response or the step limit.
8. Final turn state is persisted and `session.idle` is emitted.

No question answer is converted into a synthetic user turn. Tool output is never flattened into user prose.

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

First-party file tools still execute in the trusted runtime, but every path is resolved through the workspace boundary and symlink/traversal checks.

## Provider layer

The provider layer talks directly to:

- OpenAI/OpenAI-compatible Chat Completions streaming;
- Anthropic Messages streaming;
- Google Gemini streaming.

Provider adapters normalize text, tool calls, usage and finish reasons into the native agent loop. Provider API keys remain server-side and are encrypted at rest.

## Subagents

`task` creates a nested model loop with a deliberately restricted tool set (`read`, `list`, `glob`, `grep`). The child cannot mutate the workspace, use the network, or ask the user; it returns an evidence-based report to the parent turn.
