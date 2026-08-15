import { describe, expect, it } from "vitest";
import { eventMessageId, eventPartId, eventSessionId } from "./eventGuards";

/**
 * Слой совместимости с версиями движка.
 *
 * Эти цепочки существуют потому, что поля могут находиться в совместимых вариантах payload:
 * `sessionID` / `session_id` / `sessionId`, корень события против вложенных
 * `part` / `info` / `message`. Пока они стояли развёрнутыми внутри
 * `applyEvent`, их было три слегка разных копии и ноль тестов.
 *
 * Цена промаха — не исключение, а тишина: сообщение не появляется, дельта
 * теряется, ход не закрывается. Поэтому проверяется каждая ветка, а не «в
 * целом работает».
 */

describe("eventSessionId", () => {
  it.each([
    ["sessionID", { sessionID: "ses_1" }],
    ["session_id", { session_id: "ses_1" }],
    ["sessionId", { sessionId: "ses_1" }],
  ])("корень: %s", (_name, p) => {
    expect(eventSessionId(p)).toBe("ses_1");
  });

  it.each([
    ["part", { part: { sessionID: "ses_1" } }],
    ["info", { info: { sessionID: "ses_1" } }],
    ["message", { message: { sessionID: "ses_1" } }],
  ])("вложенный объект: %s", (_name, p) => {
    expect(eventSessionId(p)).toBe("ses_1");
  });

  it("корень выигрывает у вложенного", () => {
    expect(
      eventSessionId({
        sessionID: "ses_root",
        part: { sessionID: "ses_part" },
      }),
    ).toBe("ses_root");
  });

  it("порядок вариантов корня: sessionID сильнее snake_case", () => {
    expect(eventSessionId({ sessionID: "a", session_id: "b" })).toBe("a");
    expect(eventSessionId({ session_id: "b", sessionId: "c" })).toBe("b");
  });

  it("нет сессии — пустая строка, а не undefined", () => {
    // Вызывающий проверяет её как `if (!sid)`; undefined сработал бы так же,
    // но тип обещает строку — и обещание должно быть правдой.
    expect(eventSessionId({})).toBe("");
    expect(eventSessionId(null)).toBe("");
    expect(eventSessionId(undefined)).toBe("");
    expect(eventSessionId("строка")).toBe("");
  });

  it("нестроковое и пустое значение не считается найденным", () => {
    expect(eventSessionId({ sessionID: 42, session_id: "ses_1" })).toBe(
      "ses_1",
    );
    expect(eventSessionId({ sessionID: "", session_id: "ses_1" })).toBe(
      "ses_1",
    );
  });
});

describe("eventMessageId", () => {
  it.each([
    ["messageID", { messageID: "msg_1" }],
    ["message_id", { message_id: "msg_1" }],
    ["messageId", { messageId: "msg_1" }],
  ])("корень: %s", (_name, p) => {
    expect(eventMessageId(p)).toBe("msg_1");
  });

  it("по умолчанию ищет во вложенном part", () => {
    expect(eventMessageId({ part: { messageID: "msg_1" } })).toBe("msg_1");
    expect(eventMessageId({ part: { message_id: "msg_1" } })).toBe("msg_1");
  });

  it("режим message ищет id самого сообщения", () => {
    expect(eventMessageId({ message: { id: "msg_1" } }, "message")).toBe(
      "msg_1",
    );
  });

  it("режимы не смешиваются — иначе взяли бы чужой идентификатор", () => {
    // Главное утверждение блока. У события об удалении сообщения `part` может
    // прийти от совсем другого сообщения; списки объединять нельзя.
    expect(eventMessageId({ part: { messageID: "msg_part" } }, "message")).toBe(
      "",
    );
    expect(eventMessageId({ message: { id: "msg_own" } }, "part")).toBe("");
  });

  it("нет id — пустая строка", () => {
    expect(eventMessageId({})).toBe("");
    expect(eventMessageId(null)).toBe("");
    expect(eventMessageId({ part: {} })).toBe("");
  });
});

describe("eventPartId", () => {
  it.each([
    ["partID", { partID: "prt_1" }],
    ["part_id", { part_id: "prt_1" }],
    ["partId", { partId: "prt_1" }],
  ])("корень: %s", (_name, p) => {
    expect(eventPartId(p)).toBe("prt_1");
  });

  it("вложенный part.id", () => {
    expect(eventPartId({ part: { id: "prt_1" } })).toBe("prt_1");
  });

  it("корень выигрывает у вложенного", () => {
    expect(
      eventPartId({ partID: "prt_root", part: { id: "prt_nested" } }),
    ).toBe("prt_root");
  });

  it("нет id — пустая строка", () => {
    expect(eventPartId({})).toBe("");
    expect(eventPartId(null)).toBe("");
  });
});
