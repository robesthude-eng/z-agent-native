/**
 * Пользовательские настройки интерфейса и агента одним объектом.
 *
 * Хранятся как одна синхронизируемая настройка `appSettings`: новые поля
 * не требуют менять протокол синхронизации, а сервер читает из неё
 * инструкции для агента.
 */

export type FontScale = "sm" | "md" | "lg" | "xl";
export type ChatWidth = "narrow" | "normal" | "wide" | "full";
export type SendKey = "enter" | "mod-enter";
export type ResponseStyle = "default" | "concise" | "detailed";
export type ResponseLanguage = "auto" | "ru" | "en";

export interface AppSettings {
  fontScale: FontScale;
  chatWidth: ChatWidth;
  reduceMotion: boolean;
  sendKey: SendKey;
  notifyOnDone: boolean;
  soundOnDone: boolean;
  customInstructions: string;
  responseStyle: ResponseStyle;
  responseLanguage: ResponseLanguage;
  agentReview: boolean;
  agentVisualCheck: boolean;
  agentAutoResume: boolean;
  agentDossier: boolean;
  agentMemory: boolean;
}

export const MAX_INSTRUCTIONS = 4000;

export const DEFAULT_APP_SETTINGS: AppSettings = {
  fontScale: "md",
  chatWidth: "normal",
  reduceMotion: false,
  sendKey: "enter",
  notifyOnDone: false,
  soundOnDone: false,
  customInstructions: "",
  responseStyle: "default",
  responseLanguage: "auto",
  agentReview: true,
  agentVisualCheck: true,
  agentAutoResume: true,
  agentDossier: true,
  agentMemory: true,
};

const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T =>
  typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : d;

/** Привести произвольный объект (с сервера, из старой версии) к AppSettings. */
export function normalizeAppSettings(raw: unknown): AppSettings {
  const r =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_APP_SETTINGS;
  return {
    fontScale: pick(
      r.fontScale,
      ["sm", "md", "lg", "xl"] as const,
      d.fontScale,
    ),
    chatWidth: pick(
      r.chatWidth,
      ["narrow", "normal", "wide", "full"] as const,
      d.chatWidth,
    ),
    reduceMotion:
      typeof r.reduceMotion === "boolean" ? r.reduceMotion : d.reduceMotion,
    sendKey: pick(r.sendKey, ["enter", "mod-enter"] as const, d.sendKey),
    notifyOnDone:
      typeof r.notifyOnDone === "boolean" ? r.notifyOnDone : d.notifyOnDone,
    soundOnDone:
      typeof r.soundOnDone === "boolean" ? r.soundOnDone : d.soundOnDone,
    customInstructions:
      typeof r.customInstructions === "string"
        ? r.customInstructions.slice(0, MAX_INSTRUCTIONS)
        : d.customInstructions,
    responseStyle: pick(
      r.responseStyle,
      ["default", "concise", "detailed"] as const,
      d.responseStyle,
    ),
    responseLanguage: pick(
      r.responseLanguage,
      ["auto", "ru", "en"] as const,
      d.responseLanguage,
    ),
    agentReview: bool(r.agentReview, d.agentReview),
    agentVisualCheck: bool(r.agentVisualCheck, d.agentVisualCheck),
    agentAutoResume: bool(r.agentAutoResume, d.agentAutoResume),
    agentDossier: bool(r.agentDossier, d.agentDossier),
    agentMemory: bool(r.agentMemory, d.agentMemory),
  };
}

function bool(v: unknown, d: boolean) {
  return typeof v === "boolean" ? v : d;
}

export const FONT_SIZES: Record<FontScale, string> = {
  sm: "14px",
  md: "16px",
  lg: "17.5px",
  xl: "19px",
};

export const CHAT_WIDTHS: Record<ChatWidth, string> = {
  narrow: "40rem",
  normal: "48rem",
  wide: "64rem",
  full: "100%",
};

/** Применить визуальные настройки к документу. */
export function applyAppSettings(s: AppSettings) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.style.fontSize = FONT_SIZES[s.fontScale];
  root.style.setProperty("--chat-max", CHAT_WIDTHS[s.chatWidth]);
  if (s.reduceMotion) root.dataset.reduceMotion = "true";
  else delete root.dataset.reduceMotion;
}
