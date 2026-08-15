/**
 * Синхронизация пользовательских настроек между устройствами.
 *
 * Настройки живут на сервере (`/api/user/prefs`), а локальная копия в
 * IndexedDB нужна только для мгновенного старта без сетевого запроса. Каждое
 * поле помечается временем последнего изменения, и побеждает более свежее:
 * без этого телефон, открытый после недели простоя, откатывал бы вчерашние
 * правки с ноутбука просто потому, что синхронизировался последним.
 */

import {
  api,
  type PrefEnvelope,
  type PromptModel,
  type UserPrefs,
} from "../api/client";

/** Типы значений синхронизируемых настроек — по одному источнику для стора и API. */
export interface PrefValues {
  theme: "light" | "mid" | "dark";
  sidebarCollapsed: boolean;
  workspaceOpen: boolean;
  pinnedSessions: string[];
  selectedModel: PromptModel | null;
  onboardingDone: boolean;
  chatFolders: { id: string; name: string }[];
  chatFolderAssignments: Record<string, string>;
}

const PREF_KEYS = [
  "theme",
  "sidebarCollapsed",
  "workspaceOpen",
  "pinnedSessions",
  "selectedModel",
  "onboardingDone",
  "chatFolders",
  "chatFolderAssignments",
] as const;

export type PrefKey = (typeof PREF_KEYS)[number];

/** Время последнего локального изменения каждого поля. */
export type PrefTimestamps = Partial<Record<PrefKey, number>>;

/**
 * Отправить изменённое поле на сервер.
 *
 * Ошибка сети намеренно проглатывается: значение уже сохранено локально
 * вместе с меткой времени, и следующая синхронизация при загрузке дошлёт его
 * (см. reconcilePrefs) — терять пользовательский выбор из-за офлайна нельзя.
 */
export function pushPref<K extends PrefKey>(
  key: K,
  value: PrefValues[K],
  updatedAt: number,
) {
  api
    .saveUserPrefs({ [key]: { value, updatedAt } } as UserPrefs)
    .catch(() => {});
}

function envelopeOf(prefs: UserPrefs, key: PrefKey) {
  return prefs[key] as PrefEnvelope<unknown> | undefined;
}

export interface PrefReconciliation {
  /** Поля, где сервер новее: их значения нужно применить локально. */
  apply: Partial<PrefValues>;
  /** Новые локальные метки времени после применения серверных значений. */
  timestamps: PrefTimestamps;
  /** Поля, где локальная копия новее: их нужно дослать на сервер. */
  pushBack: UserPrefs;
}

/**
 * Сопоставить серверные настройки с локальными и решить, что куда едет.
 *
 * Чистая функция без обращений к стору и сети — это делает правило слияния
 * проверяемым тестами, а не наблюдаемым только вживую на двух устройствах.
 *
 * @param server настройки, отданные сервером
 * @param localValues текущие локальные значения
 * @param localTimestamps время последнего локального изменения полей
 */
export function reconcilePrefs(
  server: UserPrefs,
  localValues: PrefValues,
  localTimestamps: PrefTimestamps,
): PrefReconciliation {
  const apply: Partial<PrefValues> = {};
  const timestamps: PrefTimestamps = {};
  const pushBack: UserPrefs = {};

  for (const key of PREF_KEYS) {
    const remote = envelopeOf(server, key);
    const remoteAt =
      remote && typeof remote.updatedAt === "number" ? remote.updatedAt : 0;
    const localAt = localTimestamps[key] ?? 0;

    if (remote && remoteAt > localAt) {
      // Сервер валидирует значения при записи, поэтому здесь достаточно
      // отнести их к объявленному типу поля.
      (apply as Record<string, unknown>)[key] = remote.value;
      timestamps[key] = remoteAt;
      continue;
    }
    // Локальная правка новее серверной (или на сервере поля ещё нет) — она
    // могла быть сделана офлайн, поэтому дошлём её вместо того, чтобы терять.
    if (localAt > remoteAt) {
      (pushBack as Record<string, PrefEnvelope<unknown>>)[key] = {
        value: localValues[key],
        updatedAt: localAt,
      };
    }
  }

  return { apply, timestamps, pushBack };
}
