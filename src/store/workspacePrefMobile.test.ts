import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import { mergePersistedState, useStore } from "./useStore";

/**
 * Панель файлов, открытая на ноутбуке, синхронизируется на все устройства.
 * На телефоне она занимает весь экран и закрывает поле ввода, поэтому после
 * синхронизации там она должна остаться закрытой.
 */
function serverPrefs(workspaceOpen: boolean) {
  return {
    workspaceOpen: { value: workspaceOpen, updatedAt: Date.now() + 1000 },
  } as never;
}

function mockViewport(narrow: boolean) {
  vi.stubGlobal("window", {
    matchMedia: (q: string) => ({ matches: narrow && q.includes("767px") }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useStore.setState({ workspaceOpen: false, prefsUpdatedAt: {} });
});

describe("syncUserPrefsFromServer / workspaceOpen", () => {
  it("на узком экране не открывает панель по серверной настройке", async () => {
    mockViewport(true);
    vi.spyOn(api, "getUserPrefs").mockResolvedValue(serverPrefs(true));
    vi.spyOn(api, "saveUserPrefs").mockResolvedValue(undefined as never);
    await useStore.getState().syncUserPrefsFromServer();
    expect(useStore.getState().workspaceOpen).toBe(false);
  });

  it("на широком экране применяет серверную настройку как раньше", async () => {
    mockViewport(false);
    vi.spyOn(api, "getUserPrefs").mockResolvedValue(serverPrefs(true));
    vi.spyOn(api, "saveUserPrefs").mockResolvedValue(undefined as never);
    await useStore.getState().syncUserPrefsFromServer();
    expect(useStore.getState().workspaceOpen).toBe(true);
  });
});

describe("восстановление сохранённых настроек / workspaceOpen", () => {
  it("на узком экране не открывает сохранённую панель файлов", () => {
    mockViewport(true);
    const merged = mergePersistedState(
      { workspaceOpen: true },
      useStore.getState(),
    );
    expect(merged.workspaceOpen).toBe(false);
  });

  it("на широком экране сохранённая панель остаётся открытой", () => {
    mockViewport(false);
    const merged = mergePersistedState(
      { workspaceOpen: true },
      useStore.getState(),
    );
    expect(merged.workspaceOpen).toBe(true);
  });
});
