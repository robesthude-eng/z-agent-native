// Filesystem tool boundary.
// Migration target for workspace read/write/edit tools currently hosted in tools.mjs.
// This module intentionally exposes small primitives first so existing runtime
// behavior can be moved without changing tool contracts.

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
