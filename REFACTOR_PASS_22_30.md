# Refactor Pass 22-30

Added extraction boundaries for agent runtime:

- agent/turn-loop.mjs
- agent/tool-cycle.mjs
- agent/completion.mjs
- agent/recovery.mjs
- agent/streaming.mjs

These modules are intentionally small adapters. They preserve the current runtime behavior while creating stable seams for moving logic from agent.mjs in subsequent passes.
