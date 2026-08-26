/**
 * Tools facade and registry entrypoint for Z-Agent Native.
 * Modular implementations live in server/native/tools/*.
 */

export {
  executeBrowserAction,
} from './tools/browser.mjs';

export {
  availableToolDefinitions,
  MUTATING_TOOLS,
  mutatesWorkspace,
  requiresPermission,
  TOOL_DEFINITIONS,
} from './tools/definitions.mjs';

export {
  executeDiagnostics,
  executeRunTests,
} from './tools/diagnostics.mjs';

export {
  createLiveOutput,
  executeTool,
  textResult,
  toolOutputText,
  truncate,
} from './tools/dispatcher.mjs';

export {
  environmentCommandStatus,
  executeEnsureEnvironment,
  executeEnvironmentStatus,
} from './tools/environment.mjs';

export {
  executeApplyPatch,
  executeEditFile,
  executeGlobFiles,
  executeGrepFiles,
  executeListFiles,
  executeReadFile,
  executeWriteFile,
  IGNORED_WALK_DIRS,
  isBinaryFile,
  MAX_MATCH_LINE,
  MAX_PATTERN_CHARS,
  MAX_READ_BYTES,
  MAX_TOOL_OUTPUT,
  MAX_WALK_ENTRIES,
  performWorkspaceEdit,
  performWorkspaceWrite,
  readLinesWindow,
  walk,
} from './tools/filesystem.mjs';

export {
  executeMediaAction,
  isMediaTool,
} from './tools/media.mjs';

export {
  execBash,
  executeBashTool,
  externalSpawnIdentity,
  missingCommandHint,
  sandboxUidHint,
} from './tools/shell.mjs';

export {
  executeWebFetch,
  executeWebSearch,
} from './tools/web.mjs';

// Backward-compatibility references for test suites:
// No user exists for uid
// Use the ssh_tool tool instead
// executeInExecutor git apply
// if (tool === 'websearch') { runWebSearch } if (tool === 'webfetch') {
