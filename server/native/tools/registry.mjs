/**
 * Tool registry boundary.
 * Future tool modules can register without growing tools.mjs.
 */
const registry = new Map();

export function registerTool(name, handler) {
  if (!name || typeof handler !== 'function') {
    throw new TypeError('Invalid tool registration');
  }
  registry.set(name, handler);
}

export function getTool(name) {
  return registry.get(name);
}

export function listTools() {
  return [...registry.keys()];
}
