# Refactor progress Pass 21

Completed:
- Extracted agent message persistence/streaming helpers from `server/native/agent.mjs`.
- Added `server/native/agent/message-parts.mjs`.
- Kept compatibility wrappers inside `agent.mjs` so callers do not change.

Goal:
- Reduce agent orchestration size.
- Prepare further extraction of turn loop, completion and recovery modules.
