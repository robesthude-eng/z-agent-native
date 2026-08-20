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
}

function csrfHeaders(): Record<string, string> {
  if (typeof document === "undefined") return {};
  const csrf = document.cookie.match(/(?:^|;\s*)(?:__Host-)?z_agent_csrf=([^;]+)/)?.[1];
  return csrf ? { "x-csrf-token": decodeURIComponent(csrf) } : {};
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
    try { message = JSON.parse(text)?.error || text; } catch {}
    throw new Error(message || `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const providerChannelsApi = {
  list: () => request<{ providers: ProviderChannel[] }>("/provider-channels"),
  save: (input: ProviderChannelSave) =>
    request<{ provider: ProviderChannel; catalog: ProviderChannelCatalogResult }>("/provider-channels", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  remove: (id: string) =>
    request<{ status: string }>(`/provider-channels/${encodeURIComponent(id)}`, { method: "DELETE" }),
  resetBuiltin: (id: string) =>
    request<{ status: string; provider: ProviderChannel }>(`/provider-channels/${encodeURIComponent(id)}/config`, { method: "DELETE" }),
  removeKey: (id: string) =>
    request<{ status: string }>(`/provider-channels/${encodeURIComponent(id)}/key`, { method: "DELETE" }),
  refresh: (id: string) =>
    request<ProviderChannelCatalogResult>(`/provider-channels/${encodeURIComponent(id)}/refresh`, {
      method: "POST",
      body: "{}",
    }),
  listManualModels: (id: string) =>
    request<{ models: { model_id: string; name: string | null; enabled: boolean; is_free: boolean }[] }>(`/provider-channels/${encodeURIComponent(id)}/manual-models`),
  addManualModel: (id: string, modelId: string, name?: string) =>
    request<{ status: string; available?: boolean | null }>(`/provider-channels/${encodeURIComponent(id)}/manual-models`, {
      method: "POST",
      body: JSON.stringify({ modelId, name: name || null }),
    }),
  deleteManualModel: (id: string, modelId: string) =>
    request<{ status: string }>(`/provider-channels/${encodeURIComponent(id)}/manual-models`, {
      method: "DELETE",
      body: JSON.stringify({ modelId }),
    }),
};
