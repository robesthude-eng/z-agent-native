/**
 * Agent event contract helpers.
 * Keeps event payload shapes stable while runtime modules are split.
 */
export function createAgentEvent(type, payload = {}) {
  return {
    type,
    timestamp: Date.now(),
    payload,
  };
}

export function isAgentEvent(value) {
  return Boolean(value && typeof value.type === 'string');
}
