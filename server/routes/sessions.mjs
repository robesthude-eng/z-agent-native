import { abortTurn, answerQuestion, clearAgentSessionState, rejectQuestion, submitTurn, waitForTurnIdle } from '../native/agent.mjs';
import { closeBrowserSessionRemote } from '../native/browser-client.mjs';
import { destroyCloudSandboxForSession } from '../native/cloud-sandbox.mjs';
import { MAX_JSON_BYTES } from '../native/config.mjs';
import { validateRuleText } from '../native/instincts.mjs';
import { clearSessionEvents, emit, openSse } from '../native/events.mjs';
import { killExecutorIdentity } from '../native/executor-client.mjs';
import { assertActionId, messageId, sessionId } from '../native/ids.mjs';
import { readJson, sendJson } from '../native/json.mjs';
import { previewDocument } from '../native/preview-document.mjs';
import { revokePreviewTokens } from '../native/preview-tokens.mjs';
import { forgetPreparedSandbox, killSandboxProcesses, shellSandboxAvailable } from '../native/sandbox.mjs';
import { invalidateStorageUsage, storageUsage } from '../native/storage-usage.mjs';
import {
  addMemory,
  clearChatInstincts,
  clearChatMemory,
  createChat,
  createChatShare,
  deleteChat,
  deleteChatShare,
  deleteMessagesFrom,
  deleteSkill,
  dequeueAction,
  enqueueAction,
  exportInstincts,
  getChat,
  getChatShare,
  getPrefs,
  getSandboxUid,
  getTurn,
  importInstincts,
  listChatShares,
  listChats,
  listInstincts,
  listMemory,
  listMessages,
  listPendingQuestions,
  listQueue,
  listSkills,
  ownsChat,
  promoteInstinct,
  putMessage,
  removeInstinct,
  removeMemory,
  renameChat,
  saveSkill,
  setInstinctStatus,
  setPrefs,
  updateMemory,
  workspaceFor,
} from '../native/store.mjs';
import { terminalEnabled } from '../native/terminal.mjs';
import { closeWorkspaceWatcher, ensureWorkspaceWatcher } from '../native/watcher.mjs';

function sanitizeTitle(raw) {
  const t = String(raw || '')
    .trim()
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 80);
  return t || 'Новый чат';
}

function decodePathPart(part) {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function sessionFromPath(pathname) {
  const match = /^\/api\/session\/([A-Za-z0-9_-]+)/.exec(pathname);
  return match ? match[1] : null;
}

function mergePrefs(current, patch) {
  const base = current && typeof current === 'object' ? current : {};
  const next = patch && typeof patch === 'object' ? patch : {};
  const merged = { ...base, ...next };
  // Папки чатов убраны из продукта: старые значения не храним.
  delete merged.chatFolders;
  delete merged.chatFolderAssignments;
  return merged;
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
      // Каждый шаг очистки — по отдельности: сбой одного (браузер/executor
      // недоступен) не должен оставлять в базе и на диске остальное.
      const step = async (name, fn) => {
        try {
          await fn();
        } catch (error) {
          console.warn(`[session.delete] ${sid} ${name}: ${error?.message || error}`);
        }
      };
      const sandboxUid = getSandboxUid(sid);
      await step('sandbox', () => killSandboxProcesses(sid));
      if (Number.isInteger(sandboxUid)) await step('executor', () => killExecutorIdentity(sandboxUid, { purge: true }));
      await step('browser', () => closeBrowserSessionRemote(sid, sandboxUid));
      await step('watcher', () => closeWorkspaceWatcher(sid));
      emit(sid, 'session.removed', {});
      // База (сообщения, ходы, вопросы, очередь — каскадом) и папка проекта.
      deleteChat(sid, ownerId);
      await step('preview', () => revokePreviewTokens(sid));
      // Память проекта, durable-задачи, результаты ходов, журнал событий.
      await step('agent', () => clearAgentSessionState(sid));
      await step('events', () => clearSessionEvents(sid));
      await step('prepared', () => forgetPreparedSandbox(sid));
      await step('cloud', () => destroyCloudSandboxForSession(sid));
      await step('memory', () => clearChatMemory(sid));
      await step('instincts', () => clearChatInstincts(sid));
      invalidateStorageUsage(ownerId);
      sendJson(res, 204, null);
      return true;
    }
    if (p === `/api/session/${sid}/share`) {
      if (req.method === 'GET') {
        sendJson(res, 200, { share: getChatShare(sid, ownerId) });
        return true;
      }
      if (req.method === 'POST') {
        sendJson(res, 200, { share: createChatShare(sid, ownerId) });
        return true;
      }
      if (req.method === 'DELETE') {
        deleteChatShare(sid, ownerId);
        sendJson(res, 204, null);
        return true;
      }
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
        toolOptions: body.toolOptions,
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
    /*
      Ответвление чата: новая сессия с копией истории ДО указанного
      сообщения. Раньше кнопка «Ответвление» в UI открывала пустой чат и
      перекладывала туда текст запроса: агент начинал с нуля и не видел
      ничего из разговора, от которого ответвлялись.

      Копируются только сообщения. Файлы воркспейса остаются в исходном чате:
      их владелец — uid песочницы той сессии, и перенос без смены владельца
      дал бы чат с файлами, в которые агент не может писать. Ответ честно
      говорит об этом полем `workspaceCopied`.
    */
    if (p === `/api/session/${sid}/fork` && req.method === 'POST') {
      const body = await readJson(req, 64 * 1024);
      const cutoff = typeof body.messageID === 'string' ? body.messageID : '';
      const history = listMessages(sid);
      const cutIndex = cutoff ? history.findIndex((m) => m.id === cutoff) : -1;
      if (cutoff && cutIndex < 0) {
        sendJson(res, 404, { error: 'Message not found' });
        return true;
      }
      const carried = cutIndex >= 0 ? history.slice(0, cutIndex) : history;
      const source = getChat(sid, ownerId);
      const chat = createChat(sessionId(), ownerId, sanitizeTitle(body.title || `${source?.title || 'Чат'} — ветка`));
      for (const message of carried) {
        const copyId = messageId();
        putMessage({
          ...message,
          id: copyId,
          sessionID: chat.id,
          info: { ...(message.info || {}), id: copyId, sessionID: chat.id },
        });
      }
      ensureWorkspaceWatcher(chat.id, workspaceFor(chat.id));
      emit(chat.id, 'session.created', { session: chat });
      sendJson(res, 200, {
        session: getChat(chat.id, ownerId) || chat,
        copied: carried.length,
        workspaceCopied: false,
      });
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
      const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload : {};
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

  if (p === '/api/user/memory' && req.method === 'GET') {
    const titles = new Map(listChats(ownerId).map((c) => [c.id, c.title]));
    sendJson(
      res,
      200,
      listMemory(ownerId, { includeAllChats: true }).map((m) => ({
        ...m,
        chatTitle: m.scope === 'global' ? null : titles.get(m.scope) || null,
      })),
    );
    return true;
  }
  if (p === '/api/user/memory' && req.method === 'POST') {
    const body = await readJson(req, 64 * 1024);
    sendJson(res, 200, addMemory(ownerId, { text: body.text, kind: body.kind, scope: 'global', source: 'user' }));
    return true;
  }
  const memMatch = /^\/api\/user\/memory\/(mem_[A-Za-z0-9_-]+)$/.exec(p);
  if (memMatch && req.method === 'PATCH') {
    const body = await readJson(req, 64 * 1024);
    const updated = updateMemory(ownerId, memMatch[1], { text: body.text, kind: body.kind });
    sendJson(res, updated ? 200 : 404, updated || { error: 'Not found' });
    return true;
  }
  if (memMatch && req.method === 'DELETE') {
    removeMemory(ownerId, memMatch[1]);
    sendJson(res, 204, null);
    return true;
  }
  if (p === '/api/user/instincts' && req.method === 'GET') {
    const titles = new Map(listChats(ownerId).map((c) => [c.id, c.title]));
    sendJson(
      res,
      200,
      listInstincts(ownerId, { includeAllChats: true, includeDismissed: true }).map((i) => ({
        ...i,
        chatTitle: i.scope === 'global' ? null : titles.get(i.scope) || null,
      })),
    );
    return true;
  }
  if (p === '/api/user/instincts/export' && req.method === 'GET') {
    sendJson(res, 200, exportInstincts(ownerId));
    return true;
  }
  if (p === '/api/user/instincts/import' && req.method === 'POST') {
    const body = await readJson(req, 256 * 1024);
    if (body?.format !== 'zagent-instincts' || !Array.isArray(body.instincts)) {
      sendJson(res, 400, { error: 'Expected a zagent-instincts export' });
      return true;
    }
    sendJson(res, 200, importInstincts(ownerId, body.instincts, { validate: validateRuleText }));
    return true;
  }
  const instinctMatch = /^\/api\/user\/instincts\/(ins_[A-Za-z0-9_-]+)$/.exec(p);
  if (instinctMatch && req.method === 'PATCH') {
    const body = await readJson(req, 16 * 1024);
    let updated = null;
    if (body?.status) updated = setInstinctStatus(ownerId, instinctMatch[1], String(body.status));
    if (body?.scope === 'global') updated = promoteInstinct(ownerId, instinctMatch[1]);
    sendJson(res, updated ? 200 : 404, updated || { error: 'Not found' });
    return true;
  }
  if (instinctMatch && req.method === 'DELETE') {
    removeInstinct(ownerId, instinctMatch[1]);
    sendJson(res, 204, null);
    return true;
  }
  if (p === '/api/user/skills' && req.method === 'GET') {
    sendJson(res, 200, listSkills(ownerId, { withContent: url.searchParams.get('metadata') !== '1' }));
    return true;
  }
  if (p === '/api/user/skills' && req.method === 'PUT') {
    const body = await readJson(req, 128 * 1024);
    sendJson(res, 200, saveSkill(ownerId, { name: body.name, description: body.description, content: body.content }));
    return true;
  }
  const skillMatch = /^\/api\/user\/skills\/(skl_[A-Za-z0-9_-]+)$/.exec(p);
  if (skillMatch && req.method === 'DELETE') {
    deleteSkill(ownerId, skillMatch[1]);
    sendJson(res, 204, null);
    return true;
  }

  if (p === '/api/user/shares' && req.method === 'GET') {
    sendJson(res, 200, listChatShares(ownerId));
    return true;
  }

  if (p === '/api/user/storage' && req.method === 'GET') {
    sendJson(res, 200, await storageUsage(ownerId, { fresh: url.searchParams.get('fresh') === '1' }));
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
