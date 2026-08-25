import { executeBrowserTool } from '../browser-client.mjs';
import { isPublicHttpUrl, readWorkspaceBrowserDocument } from '../browser-local.mjs';
import { sandboxIdentity } from '../sandbox.mjs';
import { agentNetworkPolicy, assertAgentNetworkUrl } from '../workspace-policy.mjs';

export async function executeBrowserAction(root, input, ctx = {}) {
  const action = String(input?.action || '').trim().toLowerCase();
  let payload = input && typeof input === 'object' ? { ...input } : {};
  if (action === 'open') {
    const target = String(payload.url || '').trim();
    if (!target) throw new Error('open requires url');
    if (isPublicHttpUrl(target)) {
      if (agentNetworkPolicy() === 'off') {
        throw Object.assign(new Error('browser is disabled by Z_AGENT_NETWORK_POLICY=off.'), { statusCode: 403, code: 'AGENT_NETWORK_BLOCKED' });
      }
      assertAgentNetworkUrl(target, { tool: 'browser' });
    } else {
      const local = readWorkspaceBrowserDocument(root, target);
      payload = { ...payload, html: local.html, url: local.href };
    }
  }
  const identity = sandboxIdentity(ctx.sessionId);
  return executeBrowserTool({
    sessionId: ctx.sessionId,
    uid: identity?.isolated ? identity.uid : null,
    input: payload,
    signal: ctx.signal,
  });
}
