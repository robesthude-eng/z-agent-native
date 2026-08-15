import { describe, expect, it } from "vitest";
import {
  ID_PREFIX,
  isLocalMessage,
  isSessionId,
  isTmpSession,
  sessionActionPrep,
} from "./ids";

describe("id prefix guards", () => {
  it("exposes the canonical prefixes", () => {
    expect(ID_PREFIX).toEqual({
      TMP: "tmp_",
      LOCAL: "local_",
      SESSION: "ses_",
      MESSAGE: "msg_",
      ACTION: "act_",
    });
  });

  it("detects temporary sessions", () => {
    expect(isTmpSession("tmp_123")).toBe(true);
    expect(isTmpSession("ses_123")).toBe(false);
  });

  it("detects optimistic local messages", () => {
    expect(isLocalMessage("local_abc")).toBe(true);
    expect(isLocalMessage("msg_abc")).toBe(false);
  });

  it("detects persisted session ids", () => {
    expect(isSessionId("ses_abc")).toBe(true);
    expect(isSessionId("tmp_abc")).toBe(false);
  });

  it("treats null/undefined/non-strings as no match", () => {
    expect(isTmpSession(null)).toBe(false);
    expect(isTmpSession(undefined)).toBe(false);
    expect(isLocalMessage(null)).toBe(false);
    expect(isSessionId(undefined)).toBe(false);
    expect(isSessionId("")).toBe(false);
  });
});

/**
 * I-21: действие материализует сессию.
 *
 * До этой проверки инвариант держался только на прозе контракта, и код ему
 * противоречил: прикрепление файла в новом чате не создавало сессию, а
 * упиралось в отказ «только в открытом чате».
 */
describe("sessionActionPrep: подготовка сессии под действие (I-21)", () => {
  it("настоящая сессия готова к действию", () => {
    expect(sessionActionPrep("ses_abc")).toBe("ready");
  });

  it("черновик доводится до сессии, а НЕ заменяется новым чатом", () => {
    // Разница не косметическая. Заведение нового чата в черновике переводит
    // currentID на пустой tmp_, а набранный текст остаётся черновиком
    // прежнего: пользователь видит, что прикрепление файла стёрло написанное.
    expect(sessionActionPrep("tmp_1700000000000")).toBe("materialize");
  });

  it("без открытого чата его сперва надо создать", () => {
    expect(sessionActionPrep(null)).toBe("create");
    expect(sessionActionPrep(undefined)).toBe("create");
    expect(sessionActionPrep("")).toBe("create");
  });

  it("ready не выдаётся ни на одном состоянии без серверной сессии", () => {
    // Опасен здесь только ложный `ready`: он уводит загрузку в
    // uploads/_orphan, где файл не виден агенту и не скачивается.
    for (const id of [null, undefined, "", "tmp_1", "tmp_"]) {
      expect(sessionActionPrep(id)).not.toBe("ready");
    }
  });

  it("доверяет только идентификаторам native runtime", () => {
    expect(sessionActionPrep("ses_abc123")).toBe("ready");
    expect(sessionActionPrep("abc123")).toBe("create");
  });
});
