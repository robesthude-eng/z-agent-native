# Refactor Pass 31-50

Current migration focus:
- agent.mjs facade preservation
- lifecycle extraction boundaries

Added:
- agent/runner.mjs

The next migrations should move concrete execution bodies from agent.mjs:
- executeTurnLifecycle
- tool call loop
- finalization
- durable recovery
- streaming sinks

No public exports are intentionally broken.
