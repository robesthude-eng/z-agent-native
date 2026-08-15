/**
 * Автоподтверждение разрешений.
 *
 * Пользователь работает в изолированной песочнице своего чата и не хочет
 * подтверждать каждый вызов инструмента. Но у автоподтверждения есть опасный
 * режим отказа: если ответ до сервера не дошёл, агент остаётся ждать
 * разрешения вечно, а карточки, которой это можно исправить, уже нет. Поэтому
 * тесты проверяют не только «карточка не появилась», но и возврат запроса в
 * очередь при сбое.
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
    // Ответ уходит асинхронно — даём микротаскам отработать.
    await Promise.resolve();
    await Promise.resolve();

    expect(respond).toHaveBeenCalledWith("ses_perm", "perm_1", "always");
    expect(store.permissions).toEqual([]);
  });

  test("puts the request back so a card can appear when the answer fails", async () => {
    vi.spyOn(api, "respondPermission").mockRejectedValue(
      new Error("503 Service Unavailable"),
    );
    const store = makeStore();

    store.applyEvent(askEvent("perm_fail"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Иначе агент ждал бы разрешения, которого сервер не получил, без
    // единого элемента интерфейса, чтобы это исправить.
    expect(store.permissions.map((p) => p.id)).toEqual(["perm_fail"]);
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

  test("permission.responded clears anything still queued", async () => {
    vi.spyOn(api, "respondPermission").mockRejectedValue(new Error("boom"));
    const store = makeStore();

    store.applyEvent(askEvent("perm_x"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(store.permissions).toHaveLength(1);

    store.applyEvent({
      type: "permission.responded",
      properties: { id: "perm_x" },
    } as AppEvent);

    expect(store.permissions).toEqual([]);
  });
});
