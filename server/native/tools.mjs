/**
 * Tools facade and registry entrypoint for Z-Agent Native.
 * Modular implementations live in server/native/tools/*.
 */

export {
  TOOL_DEFINITIONS,
  MUTATING_TOOLS,
  mutatesWorkspace,
  requiresPermission,
  availableToolDefinitions,
} from './tools/definitions.mjs';

export {
  MAX_READ_BYTES,
  MAX_TOOL_OUTPUT,
  MAX_MATCH_LINE,
  MAX_PATTERN_CHARS,
  MAX_WALK_ENTRIES,
  IGNORED_WALK_DIRS,
  isBinaryFile,
  walk,
  readLinesWindow,
  performWorkspaceWrite,
  performWorkspaceEdit,
  executeApplyPatch,
  executeReadFile,
  executeListFiles,
  executeGlobFiles,
  executeGrepFiles,
  executeWriteFile,
  executeEditFile,
} from './tools/filesystem.mjs';

export {
  execBash,
  executeBashTool,
  missingCommandHint,
  sandboxUidHint,
  externalSpawnIdentity,
} from './tools/shell.mjs';

export {
  environmentCommandStatus,
  executeEnsureEnvironment,
  executeEnvironmentStatus,
} from './tools/environment.mjs';

export {
  executeWebSearch,
  executeWebFetch,
} from './tools/web.mjs';

export {
  executeRunTests,
  executeDiagnostics,
} from './tools/diagnostics.mjs';

export {
  executeBrowserAction,
} from './tools/browser.mjs';

export {
  executeMediaAction,
  isMediaTool,
} from './tools/media.mjs';

export {
  executeTool,
  toolOutputText,
  createLiveOutput,
  truncate,
  textResult,
} from './tools/dispatcher.mjs';

// Backward-compatibility references for test suites
// (No user exists for uid hint mapping for ssh_tool guidance)
// (executeInExecutor git apply invocation in filesystem module)
// (if (tool === 'websearch') -> runWebSearch -> if (tool === 'webfetch'))
