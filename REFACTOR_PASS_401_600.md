# Refactor Pass 401-600

Base:
z-agent-native-refactoring-pass-1-400

Changes:
- added agent lifecycle boundary
- added stable agent event contract
- added tools registry boundary

This pass prepares extraction of runtime logic from agent.mjs and tools.mjs
while preserving existing exports.
