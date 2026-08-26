import {
  abortTurn, answerQuestion, clearAgentSessionState, rejectQuestion, submitTurn, waitForTurnIdle,
} from '../native/agent.mjs';
import { closeBrowserSessionRemote } from '../native/browser-client.mjs';
import { MAX_JSON_BYTES } from '../native/config.mjs';
import { clearSessionEvents, emit, openSse } from '../native/events.mjs';
import { killExecutorIdentity } from '../native/executor-client.mjs';
import { assertActionId, sessionId } from '../native/ids.mjs';
import { readJson, sendJson } from '../native/json.mjs';
import { previewDocument } from '../native/preview-document.mjs';
import { revokePreviewTokens } from '../native/preview-tokens.mjs';
import { killSandboxProcesses, shellSandboxAvailable } from '../native/sandbox.mjs';
import {
  createChat, deleteChat, deleteMessagesFrom, dequeueAction, enqueueAction, getChat, getPrefs, getSandboxUid,getTurn,
  listChats, listMessages, listPendingQuestions, listQueue, ownsChat, renameChat, setPrefs, workspaceFor, 
} from '../native/store.mjs';
import { terminalEnabled } from '../native/terminal.mjs';
import { closeWorkspaceWatcher, ensureWorkspaceWatcher } from '../native/watcher.mjs';

function sanitizeTitle(raw) {
  const t = String(raw || '').trim().replace(/[\r\n\t]+/g, ' ').slice(0, 80);
  return t || 'Новый чат';
}

function decodePathPart(part) {
  try { return decodeURIComponent(part); }
  catch { return part; }
}

function sessionFromPath(pathname) {
  const match = /^\/api\/session\/([A-Za-z0-9_-]+)/.exec(pathname);
  return match ? match[1] : null;
}

function mergePrefs(current, patch) {
  const base = current && typeof current === 'object' ? current : {};
  const next = patch && typeof patch === 'object' ? patch : {};
  return { ...base, ...next };
}

export async function handleSessionRoutes(req, res, p, url, ownerId) {
  if (p === '/api/session' && req.method === 'GET') {
    sendJson(res, 200, listChats(ownerId));
    return true;
  }

  if (p === '/api/session' && req.method === 'POST') {
    const body = await readJson(req, MAX_JSON_BYTES);
    const chat = createChat(sessionId(), ownerId, sanitizeTitle(body.title));
    ensureWorkspaceWatcher(chat.id, workspaceFor(chat.id));
    emit(chat.id, 'session.created', { session: chat });
    sendJson(res, 200, chat);
    return true;
  }

  if (p === '/api/event' && req.method === 'GET') {
    const sid = url.searchParams.get('sessionId');
    if (!sid || !ownsChat(sid, ownerId)) {
      sendJson(res, 403, { error: 'Forbidden' });
      return true;
    }
    ensureWorkspaceWatcher(sid, workspaceFor(sid));
    openSse(req, res, sid, url.searchParams.get('lastEventId') || req.headers['last-event-id'] || 0);
    return true;
  }

  const sid = sessionFromPath(p);
  if (sid) {
    if (!ownsChat(sid, ownerId)) {
      sendJson(res, 404, { error: 'Session not found' });
      return true;
    }
    if (p === `/api/session/${sid}` && req.method === 'GET') {
      sendJson(res, 200, getChat(sid, ownerId));
      return true;
    }
    if (p === `/api/session/${sid}` && req.method === 'PATCH') {
      const body = await readJson(req, 64 * 1024);
      const chat = renameChat(sid, ownerId, sanitizeTitle(body.title));
      emit(sid, 'session.updated', { session: chat });
      sendJson(res, 200, { ok: true, id: sid, title: chat.title });
      return true;
    }
    if (p === `/api/session/${sid}` && req.method === 'DELETE') {
      abortTurn(sid);
      if (!(await waitForTurnIdle(sid, 5000))) {
        sendJson(res, 409, { error: 'Agent turn is still stopping; retry deletion.' });
        return true;
      }
      killSandboxProcesses(sid);
      const sandboxUid = getSandboxUid(sid);
      if (Number.isInteger(sandboxUid)) await killExecutorIdentity(sandboxUid);
      await closeBrowserSessionRemote(sid, sandboxUid);
      closeWorkspaceWatcher(sid);
      emit(sid, 'session.removed', {});
      deleteChat(sid, ownerId);
      revokePreviewTokens(sid);
      clearAgentSessionState(sid);
      clearSessionEvents(sid);
      sendJson(res, 204, null);
      return true;
    }
    if (p === `/api/session/${sid}/message` && req.method === 'GET') {
      sendJson(res, 200, listMessages(sid));
      return true;
    }
    if (p === `/api/session/${sid}/message` && req.method === 'POST') {
      const body = await readJson(req, MAX_JSON_BYTES);
      const result = await submitTurn({
        sessionId: sid,
        ownerId,
        parts: body.parts || [],
        model: body.model || null,
        system: '',
        actionId: req.headers['x-action-id'] || '',
      });
      sendJson(res, 200, result);
      return true;
    }
    if (p === `/api/session/${sid}/abort` && req.method === 'POST') {
      abortTurn(sid);
      await waitForTurnIdle(sid, 5000);
      sendJson(res, 204, null);
      return true;
    }
    if (p === `/api/session/${sid}/revert` && req.method === 'POST') {
      const body = await readJson(req, 64 * 1024);
      abortTurn(sid);
      if (!(await waitForTurnIdle(sid, 5000))) {
        sendJson(res, 409, { error: 'Agent turn is still stopping; retry revert.' });
        return true;
      }
      const removed = deleteMessagesFrom(sid, body.messageID);
      emit(sid, 'stream.reconnected', { reason: 'history_reverted' });
      sendJson(res, 200, { ok: true, removed });
      return true;
    }
    if (p === `/api/session/${sid}/turn` && req.method === 'GET') {
      sendJson(res, 200, { turn: getTurn(sid), orchestrator: true });
      return true;
    }
    if (p === `/api/session/${sid}/capabilities` && req.method === 'GET') {
      const previewPath = previewDocument(workspaceFor(sid));
      sendJson(res, 200, {
        capabilities: {
          terminal: terminalEnabled() && shellSandboxAvailable() ? 'ready' : 'unavailable',
          workspace: 'ready',
          preview: previewPath ? 'ready' : 'unavailable',
        },
        previewPath: previewPath || null,
      });
      return true;
    }
    if (p === `/api/session/${sid}/queue` && req.method === 'GET') {
      sendJson(res, 200, { queue: listQueue(sid) });
      return true;
    }
    if (p === `/api/session/${sid}/queue` && req.method === 'POST') {
      const body = await readJson(req, 128 * 1024);
      const actionId = assertActionId(body.actionId);
      const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
        ? body.payload
        : {};
      if (typeof payload.text !== 'string' || (payload.attachments !== undefined && !Array.isArray(payload.attachments))) {
        sendJson(res, 400, { error: 'Invalid queue payload' });
        return true;
      }
      sendJson(res, 200, { outcome: enqueueAction(sid, actionId, payload) });
      return true;
    }
    if (p === `/api/session/${sid}/queue` && req.method === 'DELETE') {
      sendJson(res, 200, {
        removed: dequeueAction(sid, assertActionId(url.searchParams.get('actionId'))),
      });
      return true;
    }
  }

  if (p === '/api/question' && req.method === 'GET') {
    const qsid = url.searchParams.get('sessionId') || '';
    if (!ownsChat(qsid, ownerId)) {
      sendJson(res, 404, { error: 'Session not found' });
      return true;
    }
    sendJson(res, 200, listPendingQuestions(qsid));
    return true;
  }
  const qReply = /^\/api\/question\/([^/]+)\/(reply|reject)$/.exec(p);
  if (qReply && req.method === 'POST') {
    const qsid = url.searchParams.get('sessionId') || '';
    if (!ownsChat(qsid, ownerId)) {
      sendJson(res, 404, { error: 'Session not found' });
      return true;
    }
    const id = decodePathPart(qReply[1]);
    if (qReply[2] === 'reply') {
      const body = await readJson(req, 128 * 1024);
      if (answerQuestion(qsid, id, Array.isArray(body.answers) ? body.answers : [])) {
        sendJson(res, 204, null);
      } else {
        sendJson(res, 404, { error: 'Question not found' });
      }
      return true;
    }
    if (rejectQuestion(qsid, id)) {
      sendJson(res, 204, null);
    } else {
      sendJson(res, 404, { error: 'Question not found' });
    }
    return true;
  }

  if (p === '/api/user/prefs' && req.method === 'GET') {
    sendJson(res, 200, getPrefs(ownerId));
    return true;
  }
  if (p === '/api/user/prefs' && req.method === 'PUT') {
    const patch = await readJson(req, 512 * 1024);
    const prefs = mergePrefs(getPrefs(ownerId), patch);
    setPrefs(ownerId, prefs);
    sendJson(res, 200, { ok: true, prefs });
    return true;
  }

  return false;
}
