/**
 * Правка своего сообщения и перегенерация ответа.
 *
 * Смысл этих действий — не «отправить текст ещё раз», а заменить прошлый
 * запрос: если история на сервере не откатилась, модель увидит обе
 * формулировки и ответ будет опираться на устаревшую. Поэтому тесты проверяют
 * именно связку «откат → обрезание локальной ленты → новый prompt», включая
 * поведение на движке, который откат не поддерживает.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../../api/client";
import type { Message } from "../../api/types";
import type { State } from "../types";
import { createMessagesSlice } from "./messagesSlice";

type Store = State & ReturnType<typeof createMessagesSlice>;

function makeStore(initial: Partial<Store> = {}) {
  const store = {
    sessions: [],
    status: {},
    permissions: [],
    messages: {},
    attachments: [],
  } as unknown as Store;
  const set = (update: unknown) => {
    const next = typeof update === "function" ? update(store) : update;
    Object.assign(store, next);
  };
  const slice = createMessagesSlice(
    set as never,
    (() => store) as never,
    {} as never,
  );
  Object.assign(store, slice, initial);
  return store;
}

const sid = "ses_edit";
const history: Message[] = [
  {
    id: "msg_u1",
    role: "user",
    parts: [{ type: "text", text: "первый вопрос" }],
  },
  {
    id: "msg_a1",
    role: "assistant",
    parts: [{ type: "text", text: "первый ответ" }],
  },
  {
    id: "msg_u2",
    role: "user",
    parts: [{ type: "text", text: "второй вопрос" }],
  },
  {
    id: "msg_a2",
    role: "assistant",
    parts: [{ type: "text", text: "второй ответ" }],
  },
];

function setup() {
  const store = makeStore({
    currentID: sid,
    messages: { [sid]: [...history] },
  });
  // send() — отдельно протестированный оркестратор с сетью и таймерами;
  // здесь важен лишь факт и аргумент вызова.
  const send = vi.fn(async () => {});
  store.send = send;
  return { store, send };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("editAndResend", () => {
  test("reverts the session and drops everything from the edited message on", async () => {
    const revert = vi.spyOn(api, "revertMessage").mockResolvedValue(undefined);
    const { store, send } = setup();

    await store.editAndResend("msg_u2", "  второй вопрос, уточнённый  ");

    expect(revert).toHaveBeenCalledWith(sid, "msg_u2");
    // Остаётся только то, что было ДО правленого сообщения.
    expect(store.messages[sid]?.map((m) => m.id)).toEqual(["msg_u1", "msg_a1"]);
    // Текст уходит обрезанным — лишние пробелы не должны попадать в prompt.
    expect(send).toHaveBeenCalledWith("второй вопрос, уточнённый");
  });

  test("keeps the transcript intact when the engine cannot revert", async () => {
    vi.spyOn(api, "revertMessage").mockRejectedValue(
      new Error("404 Not Found"),
    );
    const { store, send } = setup();

    await store.editAndResend("msg_u2", "новый текст");

    // Ничего не удаляем: сервер историю не порвал, и «пропавшие» сообщения
    // всё равно вернулись бы следующим HTTP-снапшотом.
    expect(store.messages[sid]?.map((m) => m.id)).toEqual([
      "msg_u1",
      "msg_a1",
      "msg_u2",
      "msg_a2",
    ]);
    expect(send).toHaveBeenCalledWith("новый текст");
  });

  test("does not call revert for an optimistic local message", async () => {
    const revert = vi.spyOn(api, "revertMessage").mockResolvedValue(undefined);
    const store = makeStore({
      currentID: sid,
      messages: {
        [sid]: [
          {
            id: "local_abc",
            role: "user",
            parts: [{ type: "text", text: "x" }],
          },
        ],
      },
    });
    store.send = vi.fn(async () => {});

    await store.editAndResend("local_abc", "y");

    expect(revert).not.toHaveBeenCalled();
    expect(store.send).toHaveBeenCalledWith("y");
  });

  test("ignores empty text and unknown message ids", async () => {
    const revert = vi.spyOn(api, "revertMessage").mockResolvedValue(undefined);
    const { store, send } = setup();

    await store.editAndResend("msg_u2", "   ");
    await store.editAndResend("msg_missing", "текст");

    expect(revert).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(store.messages[sid]).toHaveLength(4);
  });
});

describe("regenerate", () => {
  test("replays the user message that preceded the assistant reply", async () => {
    const revert = vi.spyOn(api, "revertMessage").mockResolvedValue(undefined);
    const { store, send } = setup();

    await store.regenerate("msg_a2");

    // Откат идёт по запрос пользователя, а не по ответ ассистента: иначе
    // старый вопрос остался бы в истории дважды.
    expect(revert).toHaveBeenCalledWith(sid, "msg_u2");
    expect(store.messages[sid]?.map((m) => m.id)).toEqual(["msg_u1", "msg_a1"]);
    expect(send).toHaveBeenCalledWith("второй вопрос");
  });

  test("does nothing when no user message precedes the reply", async () => {
    const revert = vi.spyOn(api, "revertMessage").mockResolvedValue(undefined);
    const store = makeStore({
      currentID: sid,
      messages: {
        [sid]: [
          {
            id: "msg_a_orphan",
            role: "assistant",
            parts: [{ type: "text", text: "привет" }],
          },
        ],
      },
    });
    store.send = vi.fn(async () => {});

    await store.regenerate("msg_a_orphan");

    expect(revert).not.toHaveBeenCalled();
    expect(store.send).not.toHaveBeenCalled();
  });
});
