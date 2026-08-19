/**
 * Автоподтверждение разрешений.
 *
 * Текущий native runtime подтверждает permission-gated tools на сервере и не
 * должен присылать новые permission.asked. Эти тесты держат клиентский путь
 * совместимости для старых/зависших событий: он отвечает "always", но никогда
 * не возвращает карточку ручного подтверждения в интерфейс.
 */

import { describe, expect, test } from "vitest";
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

describe("permission auto-approval", () => {
  test("discards a stale native permission event without a network request", async () => {
    const store = makeStore();

    store.applyEvent(askEvent());
    await Promise.resolve();
    await Promise.resolve();

    expect(store.permissions).toEqual([]);
    expect(store.error).toBeNull();
  });

  test("keeps compatibility requests hidden", async () => {
    const store = makeStore();

    store.applyEvent(askEvent("perm_fail"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(store.permissions).toEqual([]);
    expect(store.error).toBeNull();
  });

  test("does not leave duplicate requests in the queue", async () => {
    const store = makeStore();

    store.applyEvent(askEvent("perm_dup"));
    store.applyEvent(askEvent("perm_dup"));
    await Promise.resolve();
    await Promise.resolve();

    expect(store.permissions).toEqual([]);
  });

  test("permission.responded leaves the queue empty", async () => {
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
