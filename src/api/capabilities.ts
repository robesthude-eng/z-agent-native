/**
 * Что состояние runtime-возможности означает для интерфейса (I-31).
 *
 * Контракт требует, чтобы интерфейс читал состояние, а не выводил его из того,
 * удался ли последний запрос. До этого модуля он выводил именно так: кнопка
 * терминала открывала панель всегда, а о недоступности пользователь узнавал по
 * красной строке внутри уже открытого терминала — то есть после того, как
 * потратил на это действие.
 *
 * Как и `turnVerdict.ts`, это единственная часть этапа, проверяемая без стора,
 * сети и браузера, — поэтому она и вынесена отдельно.
 */

/** Состояния автомата `capability` из `contracts/LIFECYCLES.md`. */
export type CapabilityState =
  | "unavailable"
  | "provisioning"
  | "ready"
  | "active"
  | "failed"
  | "detaching";

export type CapabilityKind = "terminal" | "preview" | "workspace";

export const CAPABILITY_KINDS: readonly CapabilityKind[] = [
  "terminal",
  "preview",
  "workspace",
];

const KNOWN: readonly CapabilityState[] = [
  "unavailable",
  "provisioning",
  "ready",
  "active",
  "failed",
  "detaching",
];

/**
 * Флаг сборки. Выключен по умолчанию: пока он выключен, интерфейс ведёт себя
 * как прежде и открывает возможности без спроса.
 */
export function isCapabilityStateEnabled(): boolean {
  try {
    return import.meta.env?.VITE_CAPABILITY_STATE !== "0";
  } catch {
    return true;
  }
}

/**
 * Можно ли открывать возможность.
 *
 * `active` тоже «можно»: она уже открыта где-то ещё, и это не повод запрещать —
 * терминал и панель файлов допускают несколько вкладок.
 *
 * Всё остальное — нельзя, включая `provisioning`: пока окружение поднимается,
 * открытая панель показывала бы пустоту, неотличимую от поломки.
 */
export function canOpen(state: CapabilityState | null): boolean {
  return state === "ready" || state === "active";
}

/**
 * Что написать пользователю, когда открывать нельзя.
 *
 * Тексты живут здесь, а не в компоненте, по той же причине, что и решение: их
 * нужно проверять, и они обязаны быть согласованы между кнопкой и подсказкой.
 * `null` означает «объяснять нечего, возможность доступна».
 */
export function reasonFor(
  kind: CapabilityKind,
  state: CapabilityState | null,
): string | null {
  if (canOpen(state)) return null;
  const what =
    kind === "terminal" ? "Терминал" : kind === "preview" ? "Превью" : "Файлы";
  switch (state) {
    case "provisioning":
      return `${what}: окружение поднимается, подождите пару секунд`;
    case "failed":
      return `${what}: окружение не поднялось. Отправьте сообщение — среда поднимется заново`;
    case "detaching":
      return `${what}: окружение отключается`;
    case "unavailable":
      return kind === "preview"
        ? "Превью: в workspace ещё нет HTML-страницы — показывать нечего"
        : `${what}: окружение ещё не создано. Отправьте сообщение в чат`;
    default:
      // Состояние неизвестно — сервер не ответил или ответил незнакомым словом.
      // Молчать нельзя: кнопка будет неактивна, и без причины это выглядит
      // поломкой интерфейса.
      return `${what}: состояние окружения неизвестно`;
  }
}

/**
 * Разбор ответа `GET /api/session/:id/capabilities`.
 *
 * Незнакомая форма даёт `null` для каждой возможности, а не бросает: ответ
 * приходит по сети, и падение разбора не должно ронять интерфейс. `null` затем
 * читается как «нельзя открыть» — то есть неизвестность толкуется осторожно.
 */
/**
 * Путь HTML для панели превью. Сервер предпочитает index.html, иначе
 * единственный (или самый свежий) HTML в корне workspace.
 */
export function parsePreviewPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as { previewPath?: unknown }).previewPath;
  if (typeof raw !== "string") return null;
  if (!/^[A-Za-z0-9._-]{1,80}\.html?$/i.test(raw)) return null;
  return raw;
}

export function parseCapabilities(
  input: unknown,
): Record<CapabilityKind, CapabilityState | null> {
  const out = {
    terminal: null,
    preview: null,
    workspace: null,
  } as Record<CapabilityKind, CapabilityState | null>;
  if (!input || typeof input !== "object") return out;
  const raw = (input as { capabilities?: unknown }).capabilities;
  if (!raw || typeof raw !== "object") return out;
  for (const kind of CAPABILITY_KINDS) {
    const value = (raw as Record<string, unknown>)[kind];
    if (typeof value === "string" && (KNOWN as string[]).includes(value)) {
      out[kind] = value as CapabilityState;
    }
  }
  return out;
}

/**
 * Как часто перечитывать состояние.
 *
 * Чаще незачем: поднятие контейнера занимает секунды, а опрос идёт по одной
 * сессии на вкладку.
 */
export const CAPABILITY_POLL_MS = 5000;

export interface GateFacts {
  kind: CapabilityKind;
  /** Состояние с сервера; `null` — не читали или ответ не разобран. */
  state: CapabilityState | null;
  /** Выбран ли настоящий чат (не черновик). */
  sessionReady: boolean;
  /** Включён ли `VITE_CAPABILITY_STATE`. */
  capsFromServer: boolean;
  /** Подпись кнопки, когда объяснять нечего. */
  fallbackTitle: string;
}

export interface GateResult {
  disabled: boolean;
  title: string;
}

/**
 * Что делает кнопка возможности (I-31).
 *
 * Решение вынесено из `TopBar.tsx` по той же причине, по которой из
 * `server/index.mjs` уехали политики доступа: внутри компонента его проверяет
 * только рендер, а рендерить весь верхний бар ради трёх условий — значит
 * проверять React, а не правило.
 *
 * Главное свойство — первое. Пока флаг выключен, ответ обязан совпадать с
 * прежним поведением бит в бит: гейт стоит на КАЖДОЙ кнопке верхнего бара, и
 * ошибка здесь отключает интерфейс целиком. Принцип выката («новый путь
 * повторяет поведение, пока не станет основным») здесь не общая фраза, а то,
 * что проверяется перебором.
 */
export function capabilityGate({
  kind,
  state,
  sessionReady,
  capsFromServer,
  fallbackTitle,
}: GateFacts): GateResult {
  // Флаг выключен — прежний гейт целиком, состояние не смотрим вовсе.
  if (!capsFromServer) {
    return { disabled: !sessionReady, title: fallbackTitle };
  }
  // Чата нет — причина не в окружении, и говорить о нём нечего. Объяснение
  // здесь было бы неверным: «окружение ещё не создано» звучит как поломка,
  // тогда как пользователь просто не выбрал чат.
  if (!sessionReady) return { disabled: true, title: fallbackTitle };
  return {
    disabled: !canOpen(state),
    title: reasonFor(kind, state) ?? fallbackTitle,
  };
}
