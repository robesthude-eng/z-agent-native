import { csrfHeaders } from "../lib/csrfCookie";

export type ProviderProtocol = "openai" | "anthropic" | "google";

export interface ProviderChannel {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  enabled: boolean;
  custom: boolean;
  connected: boolean;
  overridden: boolean;
}

export interface ProviderChannelSave {
  id?: string;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  enabled: boolean;
  key?: string;
}

export interface ProviderChannelCatalogResult {
  status: string;
  count?: number;
  error?: string | null;
  models?: { id: string; name: string }[];
  /**
   * Добавленные вручную модели, которых больше нет в живом списке
   * провайдера: они остаются в выборе моделей, пока их не удалят.
   */
  missingManual?: string[];
}

/** Строка ручной модели в том виде, в каком её хранит runtime. */
export interface ProviderChannelManualModel {
  model_id: string;
  name: string | null;
  enabled: boolean;
  is_free: boolean;
}

/**
 * Поля ручной модели, которые можно задать из настроек. Неуказанные поля
 * сервер берёт из сохранённой строки, поэтому переключатель может прислать
 * только изменённый флаг, не теряя название и признак «бесплатная».
 */
export interface ProviderChannelManualModelInput {
  modelId: string;
  name?: string | null;
  isFree?: boolean;
  enabled?: boolean;
  /** false — переключение флагов без повторного обращения к провайдеру. */
  probe?: boolean;
}

export interface ProviderChannelProbeResult {
  available: boolean;
  latencyMs: number;
  checkedAt: number;
  error?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...csrfHeaders(),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      message = JSON.parse(text)?.error || text;
    } catch {}
    throw new Error(message || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

function channelPath(id: string, suffix = "") {
  return `/provider-channels/${encodeURIComponent(id)}${suffix}`;
}

export const providerChannelsApi = {
  list: () => request<{ providers: ProviderChannel[] }>("/provider-channels"),
  save: (input: ProviderChannelSave) =>
    request<{
      provider: ProviderChannel;
      catalog: ProviderChannelCatalogResult;
    }>("/provider-channels", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  remove: (id: string) =>
    request<{ status: string }>(channelPath(id), { method: "DELETE" }),
  removeKey: (id: string) =>
    request<{ status: string }>(channelPath(id, "/key"), { method: "DELETE" }),
  refresh: (id: string) =>
    request<ProviderChannelCatalogResult>(channelPath(id, "/refresh"), {
      method: "POST",
      body: "{}",
    }),
  listManualModels: (id: string) =>
    request<{ models: ProviderChannelManualModel[] }>(
      channelPath(id, "/manual-models"),
    ),
  addManualModel: (id: string, input: ProviderChannelManualModelInput) =>
    request<{ status: string; available?: boolean | null }>(
      channelPath(id, "/manual-models"),
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    ),
  /** Проверить Model ID у провайдера, ничего не сохраняя. */
  probeManualModel: (id: string, modelId: string) =>
    request<ProviderChannelProbeResult>(
      channelPath(id, "/manual-models/probe"),
      {
        method: "POST",
        body: JSON.stringify({ modelId }),
      },
    ),
  deleteManualModel: (id: string, modelId: string) =>
    request<{ status: string }>(channelPath(id, "/manual-models"), {
      method: "DELETE",
      body: JSON.stringify({ modelId }),
    }),
  /** Скрытые модели канала: убраны из выпадающего списка, но не удалены. */
  listHiddenModels: (id: string) =>
    request<{ hidden: string[] }>(channelPath(id, "/hidden-models")),
  setModelHidden: (id: string, modelId: string, hidden: boolean) =>
    request<{ status: string }>(channelPath(id, "/hidden-models"), {
      method: "POST",
      body: JSON.stringify({ modelId, hidden }),
    }),
};
