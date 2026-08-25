import { csrfHeaders } from "../lib/csrfCookie";
import { getConfig } from "./client";

export interface ProjectChange {
  path: string;
  status?: string;
  code?: string;
  originalPath?: string;
}

export interface ProjectChangeDiff extends ProjectChange {
  patch: string;
  binary: boolean;
  truncated: boolean;
  additions: number;
  deletions: number;
}

export interface TurnResult {
  version: number;
  sessionId: string;
  messageId: string;
  turnId: string;
  startedAt: number;
  completedAt: number;
  reason?: string;
  changeCount: number;
  rolledBackAt: number | null;
  changes: ProjectChange[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getConfig().baseUrl}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.method && init.method !== "GET"
        ? { "Content-Type": "application/json", ...csrfHeaders() }
        : {}),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = text;
    try {
      const body = JSON.parse(text) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // Keep the plain response below.
    }
    throw new Error(message || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const changesApi = {
  diff: (sessionId: string, path: string) =>
    request<ProjectChangeDiff>(
      `/file/diff?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`,
    ),
  revert: (sessionId: string, path: string) =>
    request<{
      ok: boolean;
      path: string;
      status: string;
      originalPath?: string | null;
    }>(`/file/revert?sessionId=${encodeURIComponent(sessionId)}`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  turnResult: (sessionId: string, messageId: string) =>
    request<TurnResult>(
      `/workspace/turn-result?sessionId=${encodeURIComponent(sessionId)}&messageId=${encodeURIComponent(messageId)}`,
    ),
  turnResultDiff: (sessionId: string, messageId: string, path: string) =>
    request<ProjectChangeDiff>(
      `/workspace/turn-result/diff?sessionId=${encodeURIComponent(sessionId)}&messageId=${encodeURIComponent(messageId)}&path=${encodeURIComponent(path)}`,
    ),
  rollbackTurn: (sessionId: string, messageId: string) =>
    request<{
      ok: boolean;
      restored: string[];
      alreadyRolledBack?: boolean;
      rolledBackAt: number;
    }>(
      `/workspace/turn-result/rollback?sessionId=${encodeURIComponent(sessionId)}`,
      { method: "POST", body: JSON.stringify({ messageId }) },
    ),
};
