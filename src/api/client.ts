import { csrfHeaders as csrfFromCookie } from "../lib/csrfCookie";
import { isTmpSession } from "../lib/ids";
import { MAX_UPLOAD_BYTES, type ProcessedFile } from "./files";
import type {
  FileNode,
  Message,
  ProviderCatalogResponse,
  SessionInfo,
  TrackedFile,
} from "./types";

export interface ClientConfig {
  baseUrl: string;
  username?: string;
}

let config: ClientConfig = { baseUrl: "/api" };

/** Native action idempotency header used by the runtime action ledger. */
export const ACTION_ID_HEADER = "x-action-id";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// Agent prompts are long-lived requests. Their completion is governed by the
// send watchdog and SSE/HTTP reconciliation, not a second fetch timeout.
const PROMPT_REQUEST_TIMEOUT_MS: number | null = null;

export function configure(cfg: Partial<ClientConfig>) {
  config = { ...config, ...cfg };
}

export function getConfig() {
  return config;
}

/**
 * Безопасный разбор JSON-ответа: если сервер вернул HTML (SPA-fallback
 * index.html или HTML-страница ошибки от прокси), бросаем понятную ошибку
 * с именем эндпоинта вместо криптичного
 * «SyntaxError: Unexpected token '<' … is not valid JSON».
 */
export async function jsonOrThrow<T = unknown>(res: Response): Promise<T> {
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    const preview = (await res.text().catch(() => "")).slice(0, 80);
    throw new Error(
      `${res.url || "request"} → non-JSON (HTTP ${res.status}, ${ct || "no content-type"}): ${preview}`,
    );
  }
  return res.json() as Promise<T>;
}

/** Как jsonOrThrow, но возвращает null вместо исключения (для толерантных мест). */
export async function jsonOrNull<T = unknown>(
  res: Response,
): Promise<T | null> {
  try {
    return await jsonOrThrow<T>(res);
  } catch {
    return null;
  }
}

/** Same-origin JSON headers. Auth is HttpOnly cookie (credentials: include). */
function csrfHeaders(): Record<string, string> {
  return csrfFromCookie();
}

function headers(): Record<string, string> {
  return { "Content-Type": "application/json", ...csrfHeaders() };
}

async function req<T>(
  path: string,
  init?: RequestInit,
  timeoutMs: number | null = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<T> {
  // guard: обрываем запрос, если sessionID в пути уже в blacklist (и это не запрос удаления)
  const sidMatch = path.match(/\/session\/(ses_[A-Za-z0-9]+)/);
  const querySidMatch = path.match(/[?&]sessionId=(ses_[A-Za-z0-9]+)/);
  const deadSid = sidMatch?.[1] ?? querySidMatch?.[1];
  const isDelete = init?.method === "DELETE";
  if (deadSid && isSessionDead(deadSid) && !isDelete) {
    throw new SessionGoneError(deadSid, "session in local dead-list");
  }

  const controller = new AbortController();
  const timeout =
    timeoutMs === null ? null : setTimeout(() => controller.abort(), timeoutMs);
  // Релиз 4: внешний сигнал (централизованная отмена по сессии) комбинируется
  // с внутренним таймаут-контроллером.
  const externalSignal = init?.signal ?? null;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener("abort", onExternalAbort);
  }
  try {
    const res = await fetch(`${config.baseUrl}${path}`, {
      ...init,
      credentials: "include",
      signal: controller.signal,
      headers: {
        ...headers(),
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let parsedError: { error?: unknown; sessionId?: unknown } | null = null;
      try {
        parsedError = JSON.parse(body) as {
          error?: unknown;
          sessionId?: unknown;
        };
      } catch {}
      const missingSession =
        res.status === 410 ||
        (res.status === 404 && parsedError?.error === "Session not found");
      // Missing session → сессия убита на бэке. Помечаем в blacklist и бросаем
      // типизированную ошибку — sessionsSlice.select() / messagesSlice.send()
      // сами почистят стор, создадут новую сессию и повторят prompt.
      if (missingSession) {
        let sid = deadSid;
        if (!sid && typeof parsedError?.sessionId === "string")
          sid = parsedError.sessionId;
        if (sid) _markSessionDead(sid);
        throw new SessionGoneError(sid ?? "unknown", body || "session_gone");
      }
      throw new Error(`${res.status} ${res.statusText} ${body}`.trim());
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      const preview = (
        await res
          .clone()
          .text()
          .catch(() => "")
      ).slice(0, 80);
      throw new Error(
        `Request to ${path} → non-JSON (${ct || "no ct"}): ${preview}`,
      );
    }
    return res.json() as Promise<T>;
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      // Отмена внешним сигналом (кнопка «Стоп») — пробрасываем AbortError
      // как есть, это не таймаут.
      if (externalSignal?.aborted) throw err;
      const seconds =
        timeoutMs === null
          ? "the request limit"
          : `${Math.round(timeoutMs / 1000)}s`;
      throw new Error(`Request to ${path} timed out after ${seconds}`);
    }
    throw err;
  } finally {
    if (timeout) clearTimeout(timeout);
    if (externalSignal)
      externalSignal.removeEventListener("abort", onExternalAbort);
  }
}

export interface PromptModel {
  providerID: string;
  modelID: string;
}

export interface PendingQuestion {
  id: string;
  sessionID: string;
  questions: unknown[];
}

/**
 * Найти pending question именно этой сессии. Native runtime хранит вопрос
 * как часть активного turn этой сессии; sessionId здесь — её прямой identity.
 */
export function pendingQuestionForSession(
  list: readonly PendingQuestion[],
  sessionId: string,
): PendingQuestion | null {
  return (
    list.find((q) => q.sessionID === sessionId && /^que/.test(q.id)) ??
    list.find((q) => /^que/.test(q.id)) ??
    null
  );
}

/** Значение настройки вместе со временем последнего изменения (LWW-слияние). */
export interface PrefEnvelope<T> {
  value: T;
  updatedAt: number;
}

/**
 * Настройки, которые следуют за пользователем между устройствами.
 * Поля необязательные: сервер отдаёт только то, что когда-либо менялось.
 */
export interface UserPrefs {
  theme?: PrefEnvelope<"light" | "mid" | "dark">;
  sidebarCollapsed?: PrefEnvelope<boolean>;
  onboardingDone?: PrefEnvelope<boolean>;
  workspaceOpen?: PrefEnvelope<boolean>;
  pinnedSessions?: PrefEnvelope<string[]>;
  selectedModel?: PrefEnvelope<PromptModel | null>;
  chatFolders?: PrefEnvelope<{ id: string; name: string }[]>;
  chatFolderAssignments?: PrefEnvelope<Record<string, string>>;
}

// UX-fix: локальный чёрный список sessionID, отсутствие которых подтвердил сервер.
// Дальнейшие запросы к таким ID мы обрываем на клиенте, не тратя сеть.
// Запись живёт ограниченное время. Бессрочный Set рос до перезагрузки
// вкладки и навсегда блокировал sessionID, который вернул 404 из-за
// временного сбоя или роллинга реплик: сессия уже доступна, а клиент
// продолжал рвать запросы локально.
const DEAD_SESSION_TTL_MS = 5 * 60 * 1000;
const __deadSessions = new Map<string, number>();
function _markSessionDead(sid: string) {
  if (sid) __deadSessions.set(sid, Date.now() + DEAD_SESSION_TTL_MS);
}

export { _markSessionDead as markSessionDead };
export function unmarkSessionDead(sid: string) {
  if (sid) __deadSessions.delete(sid);
}
export function isSessionDead(sid: string): boolean {
  const until = __deadSessions.get(sid);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  __deadSessions.delete(sid);
  return false;
}

export class SessionGoneError extends Error {
  sessionId: string;
  constructor(sessionId: string, message = "session_gone") {
    super(message);
    this.name = "SessionGoneError";
    this.sessionId = sessionId;
  }
}

export const api = {
  health: () => req<{ status: string }>(`/global/health`),

  listSessions: () => req<SessionInfo[]>(`/session`),
  createSession: (title?: string) =>
    req<SessionInfo>(`/session`, {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
    }),
  getSession: (id: string) => req<SessionInfo>(`/session/${id}`),
  deleteSession: (id: string) =>
    req<void>(`/session/${id}`, { method: "DELETE" }),
  // Переименование чата — сохраняется на сервере и видно с любого устройства.
  renameSession: (id: string, title: string) =>
    req<{ ok: boolean; id: string; title: string }>(`/session/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  // Настройки пользователя — синхронизация между браузерами и устройствами.
  // Каждое поле несёт время последнего изменения: сервер сливает патчи по
  // правилу last-write-wins, поэтому устройство, синхронизировавшееся позже,
  // не откатывает более свежие правки с другого.
  getUserPrefs: () => req<UserPrefs>(`/user/prefs`),
  saveUserPrefs: (prefs: UserPrefs) =>
    req<{ ok: boolean; prefs: UserPrefs }>(`/user/prefs`, {
      method: "PUT",
      body: JSON.stringify(prefs),
    }),
  /**
   * Отмена — такое же действие со своим ключом идемпотентности (I-13).
   * Повторное нажатие «Стоп» с тем же ключом безопасно: сервер вернёт
   * сохранённый результат, а не отправит второй abort.
   */
  /**
   * Серверная очередь отправки (этап 2.4).
   *
   * Ключ действия тот же, с которым сообщение потом уйдёт: очередь и реестр
   * говорят об одном действии, и второй идентификатор для него завести
   * нельзя — дедуп опирается ровно на этот.
   */
  listQueue: (sessionId: string) =>
    req<{ queue: unknown[] }>(`/session/${sessionId}/queue`),

  enqueueAction: (
    sessionId: string,
    actionId: string,
    text: string,
    attachments: ProcessedFile[] = [],
  ) =>
    req<{ outcome: string }>(`/session/${sessionId}/queue`, {
      method: "POST",
      body: JSON.stringify({ actionId, payload: { text, attachments } }),
    }),

  dequeueAction: (sessionId: string, actionId: string) =>
    req<{ removed: boolean }>(
      `/session/${sessionId}/queue?actionId=${encodeURIComponent(actionId)}`,
      { method: "DELETE" },
    ),

  abortSession: (id: string) =>
    req<void>(`/session/${id}/abort`, { method: "POST" }),

  /**
   * Откат сессии к состоянию ДО указанного сообщения — основа «изменить
   * сообщение» и «перегенерировать ответ»: без него старая формулировка
   * осталась бы в контексте модели рядом с новой.
   * Реализуется native runtime; если серверный роут не
   * поддерживает, вызывающий откатывается на отправку без переписывания
   * истории — см. messagesSlice.editAndResend.
   */
  revertMessage: (id: string, messageID: string) =>
    req<void>(`/session/${id}/revert`, {
      method: "POST",
      body: JSON.stringify({ messageID }),
    }),
  listMessages: (id: string) => req<Message[]>(`/session/${id}/message`),

  /**
   * Вердикт хода с сервера (I-30).
   *
   * Единственный источник, из которого интерфейсу разрешено узнавать о
   * завершении. Ни `finish`, ни `session.idle`, ни результат опроса истории
   * здесь не участвуют — их сводит в вердикт сверка на сервере.
   *
   * Маршрут отвечает `{ turn: null }`, когда активного хода нет: это ответ, а
   * не ошибка, и клиенту не за чем отличать его от «сессии не существует».
   */
  turnState: (id: string) =>
    req<import("./turnVerdict").TurnStateResponse>(`/session/${id}/turn`),

  /**
   * Состояние runtime-возможностей (I-31). Ответ намеренно типизирован как
   * `unknown`: разбирает его `parseCapabilities`, потому что незнакомую форму
   * надо превратить в «неизвестно», а не доверить типу, которого сеть не
   * гарантирует.
   */
  capabilities: (id: string) => req<unknown>(`/session/${id}/capabilities`),

  /** Effective runtime policies and tools, with secrets omitted. */
  runtimeCapabilities: () => req<unknown>("/runtime-capabilities"),

  prompt: (id: string, text: string, model?: PromptModel) =>
    req<Message>(
      `/session/${id}/message`,
      {
        method: "POST",
        body: JSON.stringify({
          parts: [{ type: "text", text }],
          ...(model ? { model } : {}),
        }),
      },
      PROMPT_REQUEST_TIMEOUT_MS,
    ),

  /**
   * @param actionId Ключ идемпотентности. Создаётся один раз вместе с
   *   действием и переиспользуется при каждом повторе отправки: сервер
   *   опознаёт повтор по нему и не создаёт второй ход (I-12).
   */
  promptWithParts: (
    id: string,
    parts: Record<string, unknown>[],
    model?: PromptModel,
    systemInstruction?: string,
    signal?: AbortSignal,
    actionId?: string,
  ) =>
    req<Message>(
      `/session/${id}/message`,
      {
        method: "POST",
        body: JSON.stringify({
          parts,
          ...(model ? { model } : {}),
          ...(systemInstruction ? { system: systemInstruction } : {}),
        }),
        ...(signal ? { signal } : {}),
        ...(actionId ? { headers: { [ACTION_ID_HEADER]: actionId } } : {}),
      },
      PROMPT_REQUEST_TIMEOUT_MS,
    ),

  // Native Question API продолжает тот же agent turn. Ответ не создаёт
  // нового user-message и не вызывает abort текущего tool-call.
  listPendingQuestions: (id: string) =>
    req<PendingQuestion[]>(`/question?sessionId=${encodeURIComponent(id)}`),
  waitForPendingQuestion: async (
    id: string,
    attempts = 6,
    delayMs = 120,
  ): Promise<PendingQuestion | null> => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const list = await req<PendingQuestion[]>(
        `/question?sessionId=${encodeURIComponent(id)}`,
      );
      const pending = pendingQuestionForSession(list, id);
      if (pending) return pending;
      if (attempt + 1 < attempts) {
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return null;
  },
  replyQuestion: (id: string, requestId: string, answers: string[][]) =>
    req<void>(
      `/question/${encodeURIComponent(requestId)}/reply?sessionId=${encodeURIComponent(id)}`,
      {
        method: "POST",
        body: JSON.stringify({ answers }),
      },
    ),
  rejectQuestion: (id: string, requestId: string) =>
    req<void>(
      `/question/${encodeURIComponent(requestId)}/reject?sessionId=${encodeURIComponent(id)}`,
      {
        method: "POST",
        body: "{}",
      },
    ),

  listDir: (path = ".", sessionId?: string | null) =>
    req<FileNode[]>(
      `/file?path=${encodeURIComponent(path)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    ),
  // Рекурсивный листинг всего воркспейса одним native-runtime запросом —
  // убирает N+1 при обновлении файлового дерева.
  listTree: (sessionId: string) =>
    req<FileNode[]>(
      `/workspace/tree?sessionId=${encodeURIComponent(sessionId)}`,
    ),
  readFile: (path: string, sessionId?: string | null) =>
    req<{ content?: string; text?: string; path: string }>(
      `/file/content?path=${encodeURIComponent(path)}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    ),
  gitStatus: (sessionId?: string | null) =>
    req<TrackedFile[]>(
      `/file/status${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    ),

  // Правки файлов воркспейса напрямую через native runtime, без отдельного
  // агентного хода. Все операции требуют sessionId, чтобы runtime выбрал
  // изолированный каталог сессии.
  writeFile: (path: string, content: string, sessionId: string) =>
    req<{ ok: boolean; path: string; size: number }>(
      `/workspace/file?sessionId=${encodeURIComponent(sessionId)}`,
      { method: "PUT", body: JSON.stringify({ path, content }) },
    ),
  createFile: (
    path: string,
    sessionId: string,
    type: "file" | "directory" = "file",
  ) =>
    req<{ ok: boolean; path: string; type: string }>(
      `/workspace/file?sessionId=${encodeURIComponent(sessionId)}`,
      { method: "POST", body: JSON.stringify({ path, type }) },
    ),
  deleteFile: (path: string, sessionId: string) =>
    req<{ ok: boolean; path: string }>(
      `/workspace/file?path=${encodeURIComponent(path)}&sessionId=${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    ),
  renameFile: (from: string, to: string, sessionId: string) =>
    req<{ ok: boolean; from: string; to: string }>(
      `/workspace/file/rename?sessionId=${encodeURIComponent(sessionId)}`,
      { method: "POST", body: JSON.stringify({ from, to }) },
    ),

  uploadFolder: async (
    files: { path: string; file: File }[],
    sessionId: string,
  ) => {
    const oversized = files.find(({ file }) => file.size > MAX_UPLOAD_BYTES);
    if (oversized) {
      throw new Error(
        `${oversized.path}: file exceeds the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB upload limit`,
      );
    }
    const totalBytes = files.reduce((sum, { file }) => sum + file.size, 0);
    const maxFolderBytes = 250 * 1024 * 1024;
    if (totalBytes > maxFolderBytes) {
      throw new Error("Folder upload exceeds the 250 MB batch limit");
    }
    const form = new FormData();
    for (const { path, file } of files) {
      form.append(path, file);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15 * 60_000);
    try {
      const res = await fetch(
        `${config.baseUrl}/workspace/upload-folder?sessionId=${encodeURIComponent(sessionId)}`,
        {
          method: "POST",
          credentials: "include",
          headers: csrfHeaders(),
          body: form,
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`${res.status} ${res.statusText} ${body}`.trim());
      }
      return jsonOrThrow<{
        ok: boolean;
        written: number;
        errors?: string[];
      }>(res);
    } finally {
      clearTimeout(timeout);
    }
  },

  uploadFile: (
    file: File,
    onProgress?: (pct: number) => void,
    sessionId?: string | null,
  ): Promise<{
    ok: boolean;
    /** Каноническое имя, назначенное сервером (см. resolveUniqueName). */
    name?: string;
    path: string;
    /** Путь относительно корня workspace: uploads/<имя>. */
    workspacePath?: string;
    agentPath?: string | null;
    size: number;
    kind?: string | null;
    entryCount?: number | null;
  }> =>
    new Promise((resolve, reject) => {
      const base = `${config.baseUrl}/workspace/upload`;
      const url = sessionId
        ? `${base}?sessionId=${encodeURIComponent(sessionId)}`
        : base;
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.timeout = 15 * 60_000;
      xhr.withCredentials = true;
      for (const [name, value] of Object.entries(csrfHeaders())) {
        xhr.setRequestHeader(name, value);
      }
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText));
          } catch {
            reject(new Error("Invalid server response"));
          }
        } else {
          try {
            reject(
              new Error(JSON.parse(xhr.responseText)?.error || xhr.statusText),
            );
          } catch {
            reject(new Error(`${xhr.status} ${xhr.statusText}`));
          }
        }
      };
      xhr.onerror = () => reject(new Error("Upload failed — network error"));
      xhr.ontimeout = () =>
        reject(new Error("Upload timed out after 15 minutes"));
      xhr.onabort = () => reject(new Error("Upload cancelled"));
      const form = new FormData();
      form.append("file", file, file.name);
      xhr.send(form);
    }),

  /**
   * Каталог моделей загружается одним запросом. Runtime собирает его из того же
   * provider registry, который использует для inference, поэтому клиент не
   * держит собственного списка провайдеров и не создаёт второй source of truth.
   */
  // force=true доходит до провайдера мимо пятиминутного кэша каталога.
  // Без этого кнопка «Обновить модели» обновляла только экран провайдера,
  // а выпадающий список сверху ещё несколько минут показывал старый набор.
  listProviderCatalog: (force = false) =>
    req<ProviderCatalogResponse>(
      `/providers/models${force ? "?refresh=1" : ""}`,
      undefined,
      45_000,
    ),

  saveCustomKey: (providerId: string, key: string) =>
    req<{ status: string }>(`/auth/custom`, {
      method: "POST",
      body: JSON.stringify({ providerId, key }),
    }),
  removeCustomKey: (providerId: string) =>
    req<{ status: string }>(`/auth/custom`, {
      method: "DELETE",
      body: JSON.stringify({ providerId }),
    }),
  listCustomKeys: () => req<string[]>(`/auth/custom`),

  // Смена пароля: сервер требует текущий пароль и разлогинивает остальные
  // устройства, поэтому в ответе приходит количество сброшенных сессий.
  changePassword: (currentPassword: string, newPassword: string) =>
    req<{ status: string; revokedSessions: number }>(`/auth/change-password`, {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  logout: () =>
    req<{ status: string }>(`/auth/logout`, { method: "POST", body: "{}" }),
};

/**
 * Native SSE URL. Поток всегда scoped к одной реальной сессии; EventSource
 * передаёт auth-cookie same-origin, а runtime умеет replay по lastEventId.
 */
/**
 * URL скачивания файла из workspace сессии (кликабельные файл-чипы).
 * Роут отдаёт файл с Content-Disposition: attachment; авторизация —
 * HttpOnly-cookie, браузер отправляет её автоматически (same-origin).
 */
export function workspaceDownloadUrl(
  filePath: string,
  sessionId?: string | null,
): string {
  // Старые истории могли сохранить абсолютный/legacy-путь; download route
  // принимает только путь относительно корня workspace текущей сессии.
  const rel = filePath
    // Обёртка из бэктиков/кавычек («📎 x → `src/a.ts`») — тоже legacy-мусор:
    // с ней path в URL кодируется как %60src/a.ts%60 и сервер отдаёт ENOENT.
    .replace(/^["'`]+/, "")
    .replace(/["'`]+$/, "")
    .replace(/^file:\/\//, "")
    .replace(/\\/g, "/")
    .replace(/^\/session\/workspace\//, "")
    .replace(/^sessions\/[^/]+\/workspace\//, "")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
  const sid = sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : "";
  return `/api/workspace/download?path=${encodeURIComponent(rel)}${sid}`;
}

export function eventUrl(sessionId?: string | null): string {
  if (sessionId && !isTmpSession(sessionId)) {
    return `${config.baseUrl}/event?sessionId=${encodeURIComponent(sessionId)}`;
  }
  return `${config.baseUrl}/event`;
}
