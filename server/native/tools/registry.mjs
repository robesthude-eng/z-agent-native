/**
 * Lightweight tool registry boundary.
 * Allows future tool modules to register without changing the dispatcher.
 */
const registry = new Map();

export function registerTool(definition) {
  if (!definition?.name) throw new Error('Tool name required');
  registry.set(definition.name, definition);
  return definition;
}

export function getTool(name) {
  return registry.get(name);
}

export function listRegisteredTools() {
  return [...registry.values()];
}
