# Refactor pass 11-20

Completed:

- extracted agent runtime coordination state into `server/native/agent/state.mjs`
- kept agent public API unchanged
- prepared the next split boundary for runner / lifecycle / recovery modules

The next safe extraction is moving turn execution functions while keeping exports stable.
