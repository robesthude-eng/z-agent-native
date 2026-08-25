// Релиз 5: тесты optimistic-удаления сессии и функционального отката
// (Релиз 4, батч 1): откат не должен затирать состояние, пришедшее по SSE
// за время ожидания ответа сервера.
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { SessionInfo } from "../../api/types";
import type { State } from "../types";
import { createSessionsSlice } from "./sessionsSlice";

type Store = State & ReturnType<typeof createSessionsSlice>;

const ses = (id: string, updated: number): SessionInfo =>
  ({ id, title: id, time: { updated } }) as SessionInfo;

function makeStore(initial: Partial<Store> = {}) {
  const store = {
    sessions: [],
    status: {},
    permissions: [],
    messages: {},
    attachments: [],
    ...initial,
  } as unknown as Store;
  const set = (update: unknown) => {
    const next = typeof update === "function" ? update(store) : update;
    Object.assign(store, next);
  };
  const slice = createSessionsSlice(
    set as never,
    (() => store) as never,
    {} as never,
  );
  Object.assign(store, slice, initial);
  return store;
}

describe("newSession: кнопка не поднимает контейнер", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("создаёт чат локально и НЕ ходит на сервер", async () => {
    // Создание сессии на бэкенде поднимает контейнер-раннер. Пока пользователь
    // печатает первое сообщение, ждать этого незачем — иначе кнопка «Новый
    // чат» стоит десяток секунд там, где могла бы стоить ноль.
    const create = vi.spyOn(api, "createSession");
    const store = makeStore({ sessions: [], currentID: null });

    await store.newSession();

    expect(create).not.toHaveBeenCalled();
    expect(store.currentID).toMatch(/^tmp_/);
    expect(store.sessions).toHaveLength(1);
  });

  it("materializeSession подменяет tmp_ на настоящую сессию", async () => {
    const create = vi
      .spyOn(api, "createSession")
      .mockResolvedValue(ses("ses_real", 5) as never);
    const store = makeStore({ sessions: [], currentID: null });
    await store.newSession();
    const tempId = store.currentID as string;
    store.messages[tempId] = [{ id: "m1" }] as never;

    await store.materializeSession();

    expect(create).toHaveBeenCalledTimes(1);
    expect(store.currentID).toBe("ses_real");
    expect(store.sessions.map((s) => s.id)).toEqual(["ses_real"]);
    // Сообщения, набранные до материализации, обязаны переехать на новый id.
    expect(store.messages.ses_real).toHaveLength(1);
    expect(store.messages[tempId]).toBeUndefined();
  });

  it("на уже материализованной сессии ничего не делает", async () => {
    const create = vi.spyOn(api, "createSession");
    const store = makeStore({
      sessions: [ses("ses_real", 1)],
      currentID: "ses_real",
    });

    await store.materializeSession();

    expect(create).not.toHaveBeenCalled();
    expect(store.currentID).toBe("ses_real");
  });

  it("откатывает оптимистичный чат, если создание упало", async () => {
    vi.spyOn(api, "createSession").mockRejectedValue(new Error("502"));
    const store = makeStore({ sessions: [], currentID: null });
    await store.newSession();

    await expect(store.materializeSession()).rejects.toThrow("502");

    // Чат-призрак не должен остаться в сайдбаре: отправка из него всё равно
    // невозможна, а выглядел бы он как обычный.
    expect(store.sessions).toHaveLength(0);
    expect(store.error).toContain("502");
  });

  it("не переключает неудавшуюся отправку нового чата на старую сессию", async () => {
    vi.spyOn(api, "createSession").mockRejectedValue(
      new Error("create failed"),
    );
    const store = makeStore({
      sessions: [ses("ses_old", 1)],
      currentID: "ses_old",
      messages: { ses_old: [] },
    });
    await store.newSession();

    await expect(store.materializeSession()).rejects.toThrow("create failed");

    expect(store.currentID).toBe("ses_old");
    expect(store.sessions.map((session) => session.id)).toEqual(["ses_old"]);
  });

  it("два параллельных вызова создают ровно одну сессию", async () => {
    const create = vi
      .spyOn(api, "createSession")
      .mockResolvedValue(ses("ses_real", 5) as never);
    const store = makeStore({ sessions: [], currentID: null });
    await store.newSession();

    await Promise.all([store.materializeSession(), store.materializeSession()]);

    expect(create).toHaveBeenCalledTimes(1);
    expect(store.sessions.map((s) => s.id)).toEqual(["ses_real"]);
  });
});

describe("removeSession: optimistic delete + откат", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("сразу убирает сессию из UI и зовёт deleteSession", async () => {
    const del = vi
      .spyOn(api, "deleteSession")
      .mockResolvedValue(undefined as never);
    const store = makeStore({
      sessions: [ses("ses_1", 2), ses("ses_2", 1)],
      messages: { ses_1: [], ses_2: [] },
      currentID: "ses_1",
    });
    const p = store.removeSession("ses_1");
    // optimistic: удалено ДО ответа сервера
    expect(store.sessions.map((s) => s.id)).toEqual(["ses_2"]);
    expect("ses_1" in store.messages).toBe(false);
    expect(store.currentID).toBeNull();
    await p;
    expect(del).toHaveBeenCalledWith("ses_1");
    expect(store.sessions.map((s) => s.id)).toEqual(["ses_2"]);
  });

  it("при ошибке сервера возвращает сессию, сообщения и currentID", async () => {
    vi.spyOn(api, "deleteSession").mockRejectedValue(new Error("500"));
    const msg = [{ id: "m1", role: "user", parts: [] }];
    const store = makeStore({
      sessions: [ses("ses_1", 2), ses("ses_2", 1)],
      messages: { ses_1: msg as never, ses_2: [] },
      currentID: "ses_1",
    });
    await store.removeSession("ses_1");
    expect(store.sessions.map((s) => s.id).sort()).toEqual(["ses_1", "ses_2"]);
    expect(store.messages.ses_1).toBe(msg);
    expect(store.currentID).toBe("ses_1");
    expect(store.error).toBe("500");
  });

  it("откат не затирает сессии, пришедшие по SSE во время удаления", async () => {
    let reject: (e: Error) => void = () => {};
    vi.spyOn(api, "deleteSession").mockImplementation(
      () =>
        new Promise((_, rej) => {
          reject = rej;
        }) as never,
    );
    const store = makeStore({
      sessions: [ses("ses_1", 2)],
      messages: { ses_1: [] },
      currentID: "ses_1",
    });
    const p = store.removeSession("ses_1");
    // пока запрос в полёте — по SSE пришла новая сессия
    store.sessions = [...store.sessions, ses("ses_new", 9)];
    reject(new Error("boom"));
    await p;
    const ids = store.sessions.map((s) => s.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain("ses_new");
    expect(ids).toContain("ses_1");
  });

  it("откат не дублирует сессию, если она уже вернулась по SSE", async () => {
    let reject: (e: Error) => void = () => {};
    vi.spyOn(api, "deleteSession").mockImplementation(
      () =>
        new Promise((_, rej) => {
          reject = rej;
        }) as never,
    );
    const store = makeStore({
      sessions: [ses("ses_1", 2)],
      messages: { ses_1: [] },
      currentID: "ses_1",
    });
    const p = store.removeSession("ses_1");
    store.sessions = [...store.sessions, ses("ses_1", 2)]; // SSE вернул её раньше
    reject(new Error("boom"));
    await p;
    expect(store.sessions.filter((s) => s.id === "ses_1")).toHaveLength(1);
  });

  it("откат уважает выбор пользователя: currentID не трогается, если сменился", async () => {
    let reject: (e: Error) => void = () => {};
    vi.spyOn(api, "deleteSession").mockImplementation(
      () =>
        new Promise((_, rej) => {
          reject = rej;
        }) as never,
    );
    const store = makeStore({
      sessions: [ses("ses_1", 2), ses("ses_2", 1)],
      messages: { ses_1: [], ses_2: [] },
      currentID: "ses_1",
    });
    const p = store.removeSession("ses_1");
    store.currentID = "ses_2"; // пользователь переключился во время удаления
    reject(new Error("boom"));
    await p;
    expect(store.currentID).toBe("ses_2");
  });
});
