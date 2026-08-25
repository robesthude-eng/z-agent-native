/**
 * Tool contract boundary.
 * Keeps tool metadata separate from execution implementation.
 */
export function createToolContract({name, description = '', execute}) {
  if (!name || typeof execute !== 'function') {
    throw new Error('Invalid tool contract');
  }
  return {name, description, execute};
}
