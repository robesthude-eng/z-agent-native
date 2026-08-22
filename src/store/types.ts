import type { StateCreator } from "zustand";
import type { PromptModel } from "../api/client";
import type { ProcessedFile } from "../api/files";
import type { TurnProjection } from "../api/turnVerdict";
import type {
  AppEvent,
  Message,
  PermissionRequest,
  SessionInfo,
  SessionStatus,
} from "../api/types";
import type { ChatFolder } from "../components/sidebar/chatGrouping";
import type { Theme } from "../config/theme";
import type { PrefTimestamps } from "./prefsSync";

export interface ModelEntry {
  providerID: string;
  providerName: string;
  sourceProviderID?: string;
  modelID: string;
  modelName: string;
  free: boolean;
  source?: "catalog" | "manual" | "custom" | "discovered";
  endpoint?: string | null;
  status?: "live" | "cache" | "unauthorized" | "unavailable" | string;
}

export interface AuthSlice {
  authed: Record<string, boolean>;
  currentUser: { email: string; role?: "admin" | "user" } | null;
  authChecking: boolean;
  login: (
    email: string,
    pass: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  register: (
    email: string,
    pass: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  checkCurrentUser: () => Promise<void>;
  loadAuth: () => Promise<void>;
  saveKey: (providerId: string, key: string) => Promise<boolean>;
  removeKey: (providerId: string) => Promise<void>;
}

export interface ModelsSlice {
  models: ModelEntry[];
  modelsLoaded: boolean;
  /** Каталог не загрузился (сеть/рантайм) — это не то же, что пустой каталог. */
  modelsError: boolean;
  selectedModel: PromptModel | null;
  loadModels: (force?: boolean) => Promise<void>;
  setSelectedModel: (m: PromptModel | null) => void;
}

export interface UiSlice {
  theme: Theme;
  settingsOpen: boolean;
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  workspaceOpen: boolean;
  pinnedSessions: string[];
  // Папки чатов и привязка чатов к ним (синхронизируются между устройствами).
  // Чат принадлежит не более чем одной папке, поэтому это карта, а не теги.
  chatFolders: ChatFolder[];
  chatFolderAssignments: Record<string, string>;
  // Приветственный тур уже пройден (синхронизируется между устройствами).
  onboardingDone: boolean;
  // Настройки с сервера хотя бы раз сверены с локальными. До этого момента
  // onboardingDone ещё может оказаться устаревшим false, поэтому тур ждёт.
  prefsSynced: boolean;
  // Файл, который просили открыть из чата (клик по пути в ответе агента).
  // Workspace забирает значение и обнуляет его: это одноразовая команда, а не
  // состояние — иначе повторный клик по тому же пути ничего бы не сделал.
  pendingOpenFile: string | null;
  // Оптимистичный оверлей имени чата на время PATCH-запроса. Намеренно НЕ
  // персистится: источник истины — сервер, иначе устаревшее локальное имя
  // перекрывало бы переименование, сделанное с другого устройства.
  sessionTitleOverrides: Record<string, string>;
  // Время последнего локального изменения каждой синхронизируемой настройки —
  // по нему сервер и клиент решают, чья версия свежее.
  prefsUpdatedAt: PrefTimestamps;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  setSettingsOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebar: () => void;
  setWorkspaceOpen: (open: boolean) => void;
  togglePinnedSession: (id: string) => void;
  /** Создать папку; возвращает её id (сразу нужен, чтобы положить в неё чат). */
  createChatFolder: (name: string) => string | null;
  renameChatFolder: (id: string, name: string) => void;
  /** Удалить папку; её чаты возвращаются в обычные группы по датам. */
  deleteChatFolder: (id: string) => void;
  /** Переложить чат в папку или, при null, вынуть из папок. */
  assignChatFolder: (sessionId: string, folderId: string | null) => void;
  completeOnboarding: () => void;
  /** Открыть файл workspace в редакторе (путь относительно корня сессии). */
  requestOpenFile: (path: string) => void;
  clearPendingOpenFile: () => void;
  renameSession: (id: string, title: string) => void;
  syncUserPrefsFromServer: () => Promise<void>;
}

export interface SessionsSlice {
  sessions: SessionInfo[];
  currentID: string | null;
  status: Record<string, SessionStatus>;
  permissions: PermissionRequest[];
  connection: "connecting" | "open" | "closed" | "idle";
  serverConnected: boolean | null;
  loading: boolean;
  error: string | null;
  sessionError: boolean;
  loadSessions: () => Promise<void>;
  select: (id: string | null) => Promise<void>;
  newSession: () => Promise<void>;
  /**
   * Довести оптимистичный tmp_-чат до настоящей сессии на сервере.
   *
   * Вызывается при ОТПРАВКЕ первого сообщения, а не по кнопке «Новый чат»:
   * создание сессии поднимает контейнер, и пока пользователь набирает текст,
   * ждать нечего. Идемпотентна — повторный вызов на уже материализованной
   * сессии ничего не делает.
   */
  materializeSession: () => Promise<void>;
  removeSession: (id: string) => Promise<void>;
  abort: () => Promise<void>;
  // Compatibility handler for stale permission events from older runtimes.
  // The native server owns automatic approval and exposes no response route.
  respondPermission: (
    permissionId: string,
    response: "once" | "always" | "reject",
  ) => Promise<void>;
  setConnection: (c: SessionsSlice["connection"]) => void;
  checkConnection: () => Promise<void>;
}

export interface MessagesSlice {
  messages: Record<string, Message[]>;
  attachments: ProcessedFile[];
  /**
   * Монотонная ревизия файлового дерева по сессии. Её бампают file watcher
   * events и завершившиеся mutating tools; Workspace использует число только
   * как сигнал немедленно перечитать дерево, сами файлы остаются на сервере.
   */
  workspaceRevision: Record<string, number>;
  /**
   * Проекция состояния хода с сервера, по идентификатору сессии (I-10).
   *
   * Клиент её только читает: состояние хода принадлежит серверу. Отсутствие
   * записи означает «проекции нет» — например, после перезагрузки страницы,
   * когда поллер вердикта внутри `send()` не запущен. Это НЕ то же, что
   * «ход завершён», и `indicatorFor` различает два случая.
   */
  turnProjection: Record<string, TurnProjection | null>;
  /**
   * Перечитать вердикт по требованию — действие при `stuck` (I-32).
   * Только чтение: заново ничего не отправляется.
   */
  refreshTurnProjection: (sessionId: string) => Promise<void>;
  // P2-fix: текст сообщения, отправка которого упала — Composer
  // возвращает его в поле ввода, чтобы он не потерялся.
  failedSendText: string | null;
  _deltaBuffer: Map<
    string,
    {
      sid: string;
      messageID: string;
      partID: string;
      field: string;
      text: string;
    }
  >;
  _flushTimer: ReturnType<typeof setTimeout> | null;
  send: (
    text: string,
    attachmentsOverride?: ProcessedFile[],
    actionIdOverride?: string,
  ) => Promise<void>;
  // Заменить своё сообщение новым текстом и перезапросить ответ: история
  // чата обрезается по это сообщение, затем уходит новый prompt.
  editAndResend: (messageId: string, text: string) => Promise<void>;
  // Перегенерировать ответ ассистента — повторяет предшествующий ему запрос
  // пользователя, откатив историю.
  regenerate: (assistantMessageId: string) => Promise<void>;
  addAttachments: (files: ProcessedFile[]) => void;
  removeAttachment: (name: string) => void;
  clearAttachments: () => void;
  clearFailedSendText: () => void;
  // Подставить текст в поле ввода (кнопка «Изменить последний запрос»).
  prefillComposer: (text: string) => void;
  applyEvent: (e: AppEvent) => void;
  flushStreamDeltas: () => void;
}

export interface State
  extends AuthSlice,
    ModelsSlice,
    UiSlice,
    SessionsSlice,
    MessagesSlice {}

export type Slice<T> = StateCreator<State, [], [], T>;

export const byUpdated = (a: SessionInfo, b: SessionInfo) =>
  (b.time?.updated ?? 0) - (a.time?.updated ?? 0);
