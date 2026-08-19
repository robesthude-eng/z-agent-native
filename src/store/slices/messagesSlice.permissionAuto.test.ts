/**
 * Автоподтверждение разрешений.
 *
 * Текущий native runtime подтверждает permission-gated tools на сервере и не
 * должен присылать новые permission.asked. Эти тесты держат клиентский путь
 * совместимости для старых/зависших событий: он отвечает "always", но никогда
 * не возвращает карточку ручного подтверждения в интерфейс.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../api/client";
import type { AppEvent } from "../../api/types";
import type { State } from "../types";
import { createMessagesSlice } from "./messagesSlice";
import { createSessionsSlice } from "./sessionsSlice";

function makeStore() {
  const store = {
    sessions: [],
    status: {},
    permissions: [],
    messages: {},
    attachments: [],
  } as unknown as State;
  const set = (update: unknown) => {
    const next = typeof update === "function" ? update(store) : update;
    Object.assign(store, next);
  };
  const get = () => store;
  Object.assign(
    store,
    createSessionsSlice(set as never, get as never, {} as never),
    createMessagesSlice(set as never, get as never, {} as never),
  );
  return store;
}

const askEvent = (id = "perm_1"): AppEvent =>
  ({
    type: "permission.asked",
    properties: {
      sessionID: "ses_perm",
      id,
      tool: "bash",
      input: { command: "npm install" },
    },
  }) as AppEvent;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("permission auto-approval", () => {
  test("answers 'always' immediately and leaves no card in the queue", async () => {
    const respond = vi
      .spyOn(api, "respondPermission")
      .mockResolvedValue(undefined);
    const store = makeStore();

    store.applyEvent(askEvent());
    await Promise.resolve();
    await Promise.resolve();

    expect(respond).toHaveBeenCalledWith("ses_perm", "perm_1", "always");
    expect(store.permissions).toEqual([]);
  });

  test("keeps the request hidden when the compatibility response fails", async () => {
    vi.spyOn(api, "respondPermission").mockRejectedValue(
      new Error("503 Service Unavailable"),
    );
    const store = makeStore();

    store.applyEvent(askEvent("perm_fail"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.permissions).toEqual([]);
    expect(store.error).toContain("503");
  });

  test("does not answer the same request twice", async () => {
    const respond = vi
      .spyOn(api, "respondPermission")
      .mockResolvedValue(undefined);
    const store = makeStore();

    store.applyEvent(askEvent("perm_dup"));
    store.applyEvent(askEvent("perm_dup"));
    await Promise.resolve();
    await Promise.resolve();

    expect(respond).toHaveBeenCalledTimes(1);
  });

  test("permission.responded leaves the queue empty", async () => {
    vi.spyOn(api, "respondPermission").mockRejectedValue(new Error("boom"));
    const store = makeStore();

    store.applyEvent(askEvent("perm_x"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.permissions).toEqual([]);

    store.applyEvent({
      type: "permission.responded",
      properties: { id: "perm_x" },
    } as AppEvent);

    expect(store.permissions).toEqual([]);
  });
});