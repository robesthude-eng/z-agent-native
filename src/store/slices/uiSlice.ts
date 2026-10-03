import { api } from "../../api/client";
import {
  applyTheme,
  getInitialTheme,
  nextTheme,
  type Theme,
} from "../../config/theme";
import { isTmpSession } from "../../lib/ids";
import {
  type PrefKey,
  type PrefValues,
  pushPref,
  reconcilePrefs,
} from "../prefsSync";
import type { Slice, State, UiSlice } from "../types";

export const createUiSlice: Slice<UiSlice> = (set, get) => {
  /**
   * Записать настройку локально, отметить время и отправить на сервер.
   * Метка времени хранится рядом со значением, чтобы следующая синхронизация
   * могла сравнить её с серверной и не потерять офлайн-правку.
   */
  const setPref = <K extends PrefKey>(key: K, value: PrefValues[K]) => {
    const updatedAt = Date.now();
    set(
      (s) =>
        // Вычисляемый ключ теряет точный тип в литерале, но K ограничен
        // PrefKey, а значение — PrefValues[K], так что поле заведомо валидно.
        ({
          [key]: value,
          prefsUpdatedAt: { ...s.prefsUpdatedAt, [key]: updatedAt },
        }) as Partial<State>,
    );
    pushPref(key, value, updatedAt);
  };

  return {
    theme: getInitialTheme(),
    settingsOpen: false,
    sidebarOpen: false,
    sidebarCollapsed: false,
    // Right workspace starts closed; preference is synced after auth.
    workspaceOpen: false,
    pinnedSessions: [],
    onboardingDone: false,
    prefsSynced: false,
    pendingOpenFile: null,
    sessionTitleOverrides: {},
    prefsUpdatedAt: {},

    toggleTheme: () => {
      // тёмная → средняя → светлая → тёмная
      const next: Theme = nextTheme(get().theme);
      applyTheme(next);
      setPref("theme", next);
    },
    setTheme: (theme) => {
      applyTheme(theme);
      setPref("theme", theme);
    },
    // settingsOpen и sidebarOpen — эфемерное состояние текущего экрана
    // (модалка, выдвижная панель на мобильном), синхронизировать его между
    // устройствами не нужно.
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
    setSidebarCollapsed: (sidebarCollapsed) =>
      setPref("sidebarCollapsed", sidebarCollapsed),
    toggleSidebar: () => setPref("sidebarCollapsed", !get().sidebarCollapsed),
    setWorkspaceOpen: (workspaceOpen) =>
      setPref("workspaceOpen", workspaceOpen),

    togglePinnedSession: (id) => {
      const current = get().pinnedSessions;
      setPref(
        "pinnedSessions",
        current.includes(id)
          ? current.filter((x) => x !== id)
          : [...current, id],
      );
    },

    completeOnboarding: () => setPref("onboardingDone", true),

    // Клик по пути файла в чате. Панель workspace открываем здесь же: просить
    // открыть файл и оставить панель закрытой — значит не выполнить действие.
    // workspaceOpen идёт через setPref (синхронизируемая настройка), а сам
    // путь — обычным set: это команда текущему экрану, а не настройка.
    requestOpenFile: (path) => {
      if (!path) return;
      if (!get().workspaceOpen) setPref("workspaceOpen", true);
      set({ pendingOpenFile: path });
    },
    clearPendingOpenFile: () => set({ pendingOpenFile: null }),

    // Переименование — клиентский оверлей над серверным заголовком:
    // пустая строка убирает оверлей и возвращает исходное название.
    forgetSessionPrefs: (ids) => {
      const gone = new Set(ids.filter(Boolean));
      if (gone.size === 0) return;
      const pinned = get().pinnedSessions;
      if (pinned.some((x) => gone.has(x)))
        setPref(
          "pinnedSessions",
          pinned.filter((x) => !gone.has(x)),
        );
      const overrides = get().sessionTitleOverrides;
      if (Object.keys(overrides).some((x) => gone.has(x)))
        set((s) => {
          const next = { ...s.sessionTitleOverrides };
          for (const id of gone) delete next[id];
          return { sessionTitleOverrides: next };
        });
    },

    renameSession: (id, title) => {
      const prev = get().sessionTitleOverrides[id];
      // Оптимистично показываем новое имя сразу…
      set((s) => {
        const overrides = { ...s.sessionTitleOverrides };
        if (title) overrides[id] = title;
        else delete overrides[id];
        return { sessionTitleOverrides: overrides };
      });
      // …и сохраняем на сервере, чтобы название было видно с любого
      // устройства. Оптимистичные tmp_-сессии на сервере ещё не существуют.
      if (isTmpSession(id)) return;
      api
        .renameSession(id, title)
        .then((res) => {
          // Название с сервера — источник правды: кладём его в список сразу,
          // не дожидаясь SSE (поток подписан только на активный чат).
          if (!res?.title) return;
          set((s) => ({
            sessions: s.sessions.map((x) =>
              x.id === id ? { ...x, title: res.title } : x,
            ),
          }));
        })
        .catch(() => {
          // Сервер недоступен — откатываем к прежнему имени.
          set((s) => {
            const overrides = { ...s.sessionTitleOverrides };
            if (prev !== undefined) overrides[id] = prev;
            else delete overrides[id];
            return { sessionTitleOverrides: overrides };
          });
        });
    },

    // Настройки следуют за пользователем: при загрузке подтягиваем серверные
    // значения и применяем те, что новее локальных, а более свежие локальные
    // (например, сделанные офлайн) дошлём обратно.
    syncUserPrefsFromServer: async () => {
      const server = await api.getUserPrefs().catch(() => null);
      if (!server) {
        // Сервер недоступен — работаем на локальной копии. Флаг всё равно
        // поднимаем, иначе приветственный тур, ждущий синхронизации, не
        // показался бы никогда.
        set({ prefsSynced: true });
        return;
      }

      const state = get();
      // Явное перечисление вместо Object.fromEntries: так TypeScript проверяет,
      // что каждое синхронизируемое поле действительно есть в сторе и совпадает
      // по типу — забытое поле станет ошибкой сборки, а не тихим рассинхроном.
      const localValues: PrefValues = {
        theme: state.theme,
        sidebarCollapsed: state.sidebarCollapsed,
        workspaceOpen: state.workspaceOpen,
        pinnedSessions: state.pinnedSessions,
        selectedModel: state.selectedModel,
        onboardingDone: state.onboardingDone,
      };

      const { apply, timestamps, pushBack } = reconcilePrefs(
        server,
        localValues,
        state.prefsUpdatedAt,
      );

      if (Object.keys(apply).length > 0) {
        set((s) => ({
          ...apply,
          prefsUpdatedAt: { ...s.prefsUpdatedAt, ...timestamps },
        }));
        // Тема меняет DOM, а не только стор, — применяем её отдельно.
        if (typeof apply.theme === "string") {
          applyTheme(apply.theme as Theme);
        }
      }

      if (Object.keys(pushBack).length > 0) {
        api.saveUserPrefs(pushBack).catch(() => {});
      }
      set({ prefsSynced: true });
    },
  };
};
