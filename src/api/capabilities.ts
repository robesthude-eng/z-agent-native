import { t, tf } from "@/i18n";
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
    kind === "terminal"
      ? t("top_bar.terminal")
      : kind === "preview"
        ? t("file_editor.prevyu")
        : t("workspace.files");
  switch (state) {
    case "provisioning":
      return tf("capabilities.0_okruzhenie_podnimaetsya_podozhdite_paru_se", [
        what,
      ]);
    case "failed":
      return tf("capabilities.0_okruzhenie_ne_podnyalos_otpravte_soobschen", [
        what,
      ]);
    case "detaching":
      return tf("capabilities.0_okruzhenie_otklyuchaetsya", [what]);
    case "unavailable":
      return kind === "preview"
        ? t("capabilities.prevyu_v_workspace_esche_net_html")
        : tf("capabilities.0_okruzhenie_esche_ne_sozdano_otpravte", [what]);
    default:
      // Состояние неизвестно — сервер не ответил или ответил незнакомым словом.
      // Молчать нельзя: кнопка будет неактивна, и без причины это выглядит
      // поломкой интерфейса.
      return tf("capabilities.0_sostoyanie_okruzheniya_neizvestno", [what]);
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
 * единственный (или самый свежий) HTML в корне workspace, а для собранных
 * проектов — dist/build/out/index.html, в том числе в подпапке проекта
 * (распакованный архив). Поэтому путь может содержать подкаталоги,
 * но не должен содержать traversal и служебные сегменты.
 */
const PREVIEW_SEGMENT = /^[A-Za-z0-9._-]{1,80}$/;

export function parsePreviewPath(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const raw = (input as { previewPath?: unknown }).previewPath;
  if (typeof raw !== "string") return null;
  if (raw.length > 240 || raw.includes("\\")) return null;
  const segments = raw.split("/");
  if (segments.length < 1 || segments.length > 4) return null;
  if (segments.some((s) => !s || !PREVIEW_SEGMENT.test(s))) return null;
  if (segments.some((s) => s === "." || s === "..")) return null;
  const lastSegment = segments.at(-1);
  if (!lastSegment || !/\.html?$/i.test(lastSegment)) return null;
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
