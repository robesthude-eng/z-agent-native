# Refactor Pass 601-900

Base: z-agent-native-refactoring-pass-401-600

Changes:
- Added shared agent module contract boundary.
- Added tool execution error boundary.
- Kept existing exports and runtime paths unchanged.

This pass is intentionally compatibility-first.
Further passes can migrate implementations behind these boundaries.
