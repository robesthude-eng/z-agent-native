import { executeBrowserTool } from '../browser-client.mjs';
import { DEFAULT_TOOL_TIMEOUT_MS } from '../config.mjs';
import { executeMediaTool, isMediaTool } from '../media.mjs';
import { sandboxIdentity, shellSandboxAvailable } from '../sandbox.mjs';
import { assertShellCommandAllowed } from '../workspace-policy.mjs';

export { isMediaTool };

export async function executeMediaAction(tool, root, input, ctx = {}, execBash) {
  const run = async (command, timeoutMs) => {
    assertShellCommandAllowed(command);
    const result = await execBash(root, command, Number(timeoutMs) || DEFAULT_TOOL_TIMEOUT_MS, ctx.signal, ctx);
    return { exit: result.code, output: [result.stdout, result.stderr].filter(Boolean).join('\n') };
  };
  const identity = sandboxIdentity(ctx.sessionId);
  const renderPage = async (payload) => await executeBrowserTool({
    sessionId: ctx.sessionId,
    uid: identity?.isolated ? identity.uid : null,
    input: payload,
    signal: ctx.signal,
  });
  return await executeMediaTool({
    tool,
    input: input && typeof input === 'object' ? input : {},
    ctx,
    root,
    run: shellSandboxAvailable() ? run : null,
    renderPage: ctx.sessionId ? renderPage : null,
  });
}
