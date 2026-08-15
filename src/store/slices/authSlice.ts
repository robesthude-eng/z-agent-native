import { api, jsonOrNull } from "../../api/client";
import { log } from "../../lib/log";
import type { AuthSlice, Slice, State } from "../types";

/**
 * Тело ответа auth-эндпоинтов. Разбираем через jsonOrNull, чтобы HTML-ответ
 * (SPA-fallback или HTML-ошибка edge-сервера) не ронял разбор JSON
 * («Unexpected token '<'»), а превращался в пустой объект.
 */
type AuthJson = {
  status?: string;
  user?: NonNullable<AuthSlice["currentUser"]>;
  error?: string;
};

async function performAuthAction(
  endpoint: string,
  email: string,
  password: string | undefined,
  defaultError: string,
  get: () => State,
  set: (updater: Partial<AuthSlice>) => void,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = ((await jsonOrNull(res)) ?? {}) as AuthJson;
    if (res.ok && data.status === "success" && data.user) {
      if (typeof window !== "undefined") {
        localStorage.removeItem("z_agent_auth_token");
      }
      set({ currentUser: data.user || { email }, authChecking: false });
      get()
        .loadSessions()
        .catch((e: unknown) => log.error("[Auth] loadSessions:", e));
      get()
        .loadModels(true)
        .catch((e: unknown) => log.error("[Auth] loadModels:", e));
      return { ok: true };
    }
    return {
      ok: false,
      error: data.error || `${defaultError} (HTTP ${res.status})`,
    };
  } catch {
    return { ok: false, error: "Ошибка соединения с сервером" };
  }
}

export const createAuthSlice: Slice<AuthSlice> = (set, get) => ({
  authed: {},
  currentUser: null,
  authChecking: true,

  checkCurrentUser: async () => {
    set({ authChecking: true });
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      const data = ((await jsonOrNull(res)) ?? {}) as AuthJson;
      if (res.ok && data.status === "success" && data.user) {
        set({ currentUser: data.user, authChecking: false });
      } else {
        set({ currentUser: null, authChecking: false });
      }
    } catch {
      set({ currentUser: null, authChecking: false });
    }
  },

  login: (email, password) =>
    performAuthAction(
      "/api/auth/login",
      email,
      password,
      "Ошибка входа",
      get,
      set,
    ),

  register: (email, password) =>
    performAuthAction(
      "/api/auth/register",
      email,
      password,
      "Ошибка регистрации",
      get,
      set,
    ),

  logout: async () => {
    try {
      await api.logout();
    } catch {
      // ignore
    }
    if (typeof window !== "undefined") {
      localStorage.removeItem("z_agent_auth_token");
    }
    set({ currentUser: null, sessions: [], currentID: null, messages: {} });
  },

  loadAuth: async () => {
    try {
      // Connected state comes only from the native owner-scoped provider-key store.
      const authed: Record<string, boolean> = {};

      // Load actual owner-scoped provider keys from the native runtime
      try {
        const custom = await api.listCustomKeys();
        for (const id of custom) authed[id] = true;
      } catch {
        // non-fatal
      }
      set({ authed });
    } catch {
      set({ authed: {} });
    }
  },

  saveKey: async (providerId, key) => {
    try {
      // The native runtime owns provider credentials; the browser never stores them.
      await api.saveCustomKey(providerId, key);
      set((s) => ({
        authed: { ...s.authed, [providerId]: true },
        modelsLoaded: false,
      }));
      get()
        .loadModels()
        .catch(() => {});
      return true;
    } catch (e) {
      set({ error: (e as Error).message });
      return false;
    }
  },

  removeKey: async (providerId) => {
    try {
      // Remove from the native owner-scoped credential store.
      await api.removeCustomKey(providerId);
      set((s) => {
        const authed = { ...s.authed };
        delete authed[providerId];
        const selectedModel =
          s.selectedModel?.providerID === providerId ? null : s.selectedModel;
        return { authed, selectedModel, modelsLoaded: false };
      });
      get()
        .loadModels()
        .catch(() => {});
    } catch (e) {
      set({ error: (e as Error).message });
    }
  },
});
