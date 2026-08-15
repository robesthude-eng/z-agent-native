import * as idb from "idb-keyval";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createAuthSlice } from "./slices/authSlice";
import { createMessagesSlice } from "./slices/messagesSlice";
import { createModelsSlice } from "./slices/modelsSlice";
import { createSessionsSlice } from "./slices/sessionsSlice";
import { createUiSlice } from "./slices/uiSlice";
import type { ModelEntry, State } from "./types";

export type { ModelEntry, State };

/**
 * Prefer IndexedDB via idb-keyval when available; fall back to localStorage.
 * Only UI prefs are persisted (theme, sidebar, last model) — never auth tokens.
 */
function makeStorage() {
  if (typeof window === "undefined" || typeof indexedDB === "undefined") {
    return createJSONStorage(() => localStorage);
  }
  return createJSONStorage(() => ({
    getItem: async (name: string): Promise<string | null> => {
      try {
        const v = await idb.get<string>(name);
        return v ?? null;
      } catch {
        return localStorage.getItem(name);
      }
    },
    setItem: async (name: string, value: string): Promise<void> => {
      try {
        await idb.set(name, value);
      } catch {
        localStorage.setItem(name, value);
      }
    },
    removeItem: async (name: string): Promise<void> => {
      try {
        await idb.del(name);
      } catch {
        localStorage.removeItem(name);
      }
    },
  }));
}

export const useStore = create<State>()(
  persist(
    (...a) => ({
      ...createAuthSlice(...a),
      ...createModelsSlice(...a),
      ...createUiSlice(...a),
      ...createSessionsSlice(...a),
      ...createMessagesSlice(...a),
    }),
    {
      name: "z-agent-prefs",
      storage: makeStorage(),
      // v1 хранил sessionTitleOverrides. Без миграции сохранённый оверлей
      // ещё один раз перекрыл бы серверное имя чата при первой загрузке после
      // обновления — ровно тот баг, который эта версия чинит.
      version: 2,
      migrate: (persisted, version) => {
        if (version >= 2) return persisted as Partial<State>;
        const { sessionTitleOverrides: _dropped, ...rest } = (persisted ??
          {}) as Partial<State> & {
          sessionTitleOverrides?: unknown;
        };
        return rest as Partial<State>;
      },
      // Локальная копия нужна лишь для мгновенного старта без сетевого запроса;
      // источник истины — сервер (см. store/prefsSync.ts). Метки времени
      // персистятся вместе со значениями, иначе правка, сделанная офлайн, не
      // смогла бы выиграть у более старой серверной при следующей загрузке.
      //
      // sessionTitleOverrides намеренно НЕ персистится: имя чата приходит с
      // сервера, а сохранённый локальный оверлей перекрывал бы переименование,
      // сделанное с другого устройства.
      partialize: (s) => ({
        theme: s.theme,
        sidebarCollapsed: s.sidebarCollapsed,
        workspaceOpen: s.workspaceOpen,
        selectedModel: s.selectedModel,
        pinnedSessions: s.pinnedSessions,
        chatFolders: s.chatFolders,
        chatFolderAssignments: s.chatFolderAssignments,
        onboardingDone: s.onboardingDone,
        prefsUpdatedAt: s.prefsUpdatedAt,
      }),
    },
  ),
);
