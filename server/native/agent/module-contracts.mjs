/**
 * Internal contracts shared by agent modules.
 * Kept separate to avoid circular dependencies.
 */
export function createModuleContext(values = {}) {
  return Object.freeze({ ...values });
}

export function requireContext(context) {
  if (!context || typeof context !== 'object') {
    throw new Error('Agent module context is required');
  }
  return context;
}
