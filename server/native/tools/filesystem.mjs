// Filesystem tool boundary.
// Migration target for workspace read/write/edit tools currently hosted in tools.mjs.
// This module keeps filesystem concerns isolated while preserving the existing
// tool contract during incremental extraction.

export const FILESYSTEM_TOOL_NAMES = [
  'read',
  'list',
  'glob',
  'grep',
  'write',
  'edit',
  'apply_patch',
];

export function isFilesystemTool(name) {
  return FILESYSTEM_TOOL_NAMES.includes(name);
}

export function registerFilesystemTools(registry, handlers = {}) {
  for (const name of FILESYSTEM_TOOL_NAMES) {
    if (typeof handlers[name] === 'function') {
      registry.set(name, handlers[name]);
    }
  }

  return registry;
}
