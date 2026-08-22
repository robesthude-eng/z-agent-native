// Z Agent Native wire contract shared by the browser and the runtime.
// Message/Part shapes are owned by this project; no external agent protocol is involved.

export interface SessionInfo {
  id: string;
  title: string;
  parentID?: string;
  share?: { url?: string } | null;
  time?: { created: number; updated: number };
  version?: string;
}

export type SessionStatus = "idle" | "busy" | "retry" | "error" | string;

/** Status can be a plain string or an object with .type — normalize at use site. */
export interface SessionStatusObject {
  type: SessionStatus;
}

export interface BasePart {
  id?: string;
}

export interface TextPart extends BasePart {
  type: "text";
  text: string;
}

export interface ReasoningPart extends BasePart {
  type: "reasoning";
  text: string;
}

export interface AttachmentPart extends BasePart {
  type: "attachment";
  name: string;
  size: number;
  kind: "image" | "zip" | "pdf" | "text" | string;
  path?: string;
  mime?: string;
  note?: string;
  dataUrl?: string;
  textPart?: Record<string, unknown>;
  part?: Record<string, unknown>;
  uploadedPath?: string;
  agentPath?: string;
  entryCount?: number;
}

export interface ToolOutput {
  type: "text" | "json" | "error";
  text?: string;
  json?: unknown;
  error?: { message?: string; name?: string };
}

export interface ToolPart extends BasePart {
  type: "tool";
  /**
   * Tool name. Wire value MAY be an object reference `{ messageID, callID }`
   * during streaming in streaming runtime updates; normalizeMessage /
   * normalizePartTool in store/helpers.ts coerces such values to `undefined`
   * before data reaches React so error #31 ("Objects are not valid as a React
   * child") can't fire. After normalization this is either a non-empty string
   * or undefined (UI should fall back to a generic "tool" label).
   */
  tool?: string;
  callID?: string;
  // In compatible persisted payloads, `state` is an OBJECT, not a string.
  state?: ToolState | string;
  input?: unknown; // legacy: some versions put input here
  output?: ToolOutput; // legacy
}

export interface ToolState {
  status?: string; // "running" | "completed" | "error"
  input?: unknown;
  output?: string | ToolOutput;
  title?: string;

  metadata?: { exit?: number; truncated?: boolean; output?: string };
  time?: { start?: number; end?: number };
}

export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | AttachmentPart
  | (BasePart & Record<string, unknown>);

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  parts: Part[];
  sessionID?: string;
  session_id?: string;
  sessionId?: string;
  time?: { created: number; completed?: number };
  info?:
    | {
        id?: string;
        role?: string;
        model?: string;
        finish?: "stop" | "error" | "length" | "tool_call" | string;
        tokens?: { input?: number; output?: number };
        time?: { created?: number; completed?: number };
        error?: {
          message?: string;
          name?: string;
          data?: { message?: string };
        };
        structured_output?: unknown;
      }
    | undefined;
  // Allow legacy/extra fields without forcing `any` casts in consumer code.
}

// Native realtime event envelope: `{ type, properties }`.
export interface AppEvent {
  type: string;
  properties: {
    sessionID?: string;
    session_id?: string;
    sessionId?: string;
    messageID?: string;
    message_id?: string;
    messageId?: string;
    partID?: string;
    part_id?: string;
    partId?: string;
    message?: Message;
    info?: Record<string, unknown>;
    part?: Part;
    session?: SessionInfo;
    status?: SessionStatus;
    id?: string; // permission id
    delta?: string;
    field?: string;
    // Имя инструмента (строка) или объект-ссылка { messageID, callID } в потоковых payload
    tool?: string | { messageID?: string; callID?: string };
    input?: unknown;
    // Релиз 5: синтетическое stream.corrupted несёт сырой чанк для диагностики.
    raw?: string;
    sourceType?: string;
  };
}

export interface PermissionRequest {
  sessionID: string;
  id: string; // permission id
  tool?: string;
  input?: unknown;
}

// --- File system / workspace ---

export interface FileNode {
  path: string; // relative path within the project
  name?: string;
  type?: "file" | "directory";
  isDirectory?: boolean;
  size?: number;
}

export type GitStatus =
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "renamed";

export interface TrackedFile {
  path: string;
  status?: GitStatus;
}

// --- Providers / models ---

/** Одна строка каталога: провайдер + модель, как их видит движок. */
export type ProviderCatalogStatus =
  | "live"
  | "cache"
  | "unauthorized"
  | "unavailable";

export type ProviderModelSource =
  | "catalog"
  | "manual"
  | "custom"
  | "discovered";

export interface ProviderCatalogModel {
  providerID: string;
  providerName: string;
  /** Исходный BYOK-провайдер. Для custom endpoint providerID виртуальный. */
  sourceProviderID?: string;
  modelID: string;
  modelName: string;
  free: boolean;
  source?: ProviderModelSource;
  endpoint?: string | null;
  status?: ProviderCatalogStatus;
}

/**
 * Ответ `/api/providers/models`. `providers` — состояние каталога по каждому
 * провайдеру: «ключ отвергнут» и «каталог недоступен» выглядят в интерфейсе
 * одинаково (моделей нет), а значат они разное.
 */
export interface ProviderCatalogResponse {
  models: ProviderCatalogModel[];
  /** Optional runtime-configured default model per provider. */
  default?: Record<string, string>;
  providers?: Record<
    string,
    { status: ProviderCatalogStatus | string; count: number }
  >;
  /** Скрытые модели по провайдерам (снятые галочки). */
  hidden?: Record<string, string[]>;
  /** Когда сервер закончил формировать эту проекцию каталога. */
  generatedAt?: number;
}
