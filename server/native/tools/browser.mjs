import fs from 'node:fs';
import path from 'node:path';
import { executeBrowserTool } from '../browser-client.mjs';
import { isPublicHttpUrl, readWorkspaceBrowserDocument } from '../browser-local.mjs';
import { sandboxIdentity, syncSandboxOwnership } from '../sandbox.mjs';
import { safeWorkspacePath } from '../security.mjs';
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
  const result = await executeBrowserTool({
    sessionId: ctx.sessionId,
    uid: identity?.isolated ? identity.uid : null,
    input: payload,
    signal: ctx.signal,
  });
  if (action === 'screenshot' && result?.data) return saveScreenshot(root, input, result, ctx);
  return result;
}

const SCREENSHOT_DIR = '.screenshots';
const MAX_ATTACHED_SCREENSHOT_BYTES = 3.5 * 1024 * 1024;

/**
 * Раньше снимок возвращался base64-строкой, которую никто не читал: модель
 * получала только «Rendered screenshot (N KB)», а файла не появлялось.
 * Теперь снимок сохраняется в воркспейс (его видно в чате и в файлах) и сразу
 * показывается модели как картинка.
 */
function saveScreenshot(root, input, result, ctx) {
  const bytes = Buffer.from(String(result.data), 'base64');
  const jpeg = String(input?.imageType || '').toLowerCase() === 'jpeg';
  const requested = String(input?.path || '').trim();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const relPath = requested || `${SCREENSHOT_DIR}/screenshot-${stamp}.${jpeg ? 'jpg' : 'png'}`;
  const full = safeWorkspacePath(root, relPath, { allowMissing: true });
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, bytes);
  if (ctx?.sessionId) {
    try { syncSandboxOwnership(ctx.sessionId, root, full); } catch {}
  }
  const target = path.relative(root, full).split(path.sep).join('/');
  const mime = /\.jpe?g$/i.test(target) ? 'image/jpeg' : 'image/png';
  const attach = bytes.length <= MAX_ATTACHED_SCREENSHOT_BYTES;
  const width = Number(input?.width) || 1280;
  return {
    output: [
      `Screenshot saved to ${target} (${Math.round(bytes.length / 1024)} KB, viewport width ${width}px${input?.fullPage === false ? '' : ', full page'}).`,
      attach
        ? 'The image is attached below: look at it and check the layout yourself.'
        : 'It is too large to attach directly; call view_media on this path to look at a scaled copy.',
    ].join(' '),
    title: target,
    metadata: {
      ...(result.metadata || {}),
      media: { kind: 'image', path: target, mimeType: mime, bytes: bytes.length, engine: 'browser' },
    },
    mutatedPaths: [target],
    visualMedia: attach ? [{ name: target, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` }] : [],
  };
}
