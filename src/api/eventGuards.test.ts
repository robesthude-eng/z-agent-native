import { describe, expect, it } from "vitest";
import {
  errorMessage,
  isAbortedError,
  isAppEventShaped,
  isRecord,
  statusText,
  strField,
} from "./eventGuards";

describe("isRecord", () => {
  it("accepts plain objects and arrays", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord([])).toBe(true);
  });

  it("rejects null and primitives", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord("str")).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord(false)).toBe(false);
  });
});

describe("strField", () => {
  it("returns the value for string fields", () => {
    expect(strField({ sessionID: "ses_1" }, "sessionID")).toBe("ses_1");
  });

  it("returns undefined for missing, non-string or non-object inputs", () => {
    expect(strField({ sessionID: 1 }, "sessionID")).toBeUndefined();
    expect(strField({}, "sessionID")).toBeUndefined();
    expect(strField(null, "sessionID")).toBeUndefined();
    expect(strField("nope", "sessionID")).toBeUndefined();
  });
});

describe("isAppEventShaped", () => {
  it("accepts frames with a string type and object properties", () => {
    expect(isAppEventShaped({ type: "message.updated", properties: {} })).toBe(
      true,
    );
  });

  it("rejects malformed frames", () => {
    expect(isAppEventShaped({ type: "x" })).toBe(false);
    expect(isAppEventShaped({ properties: {} })).toBe(false);
    expect(isAppEventShaped({ type: 1, properties: {} })).toBe(false);
    expect(isAppEventShaped(null)).toBe(false);
  });
});

describe("statusText", () => {
  it("passes strings through", () => {
    expect(statusText("busy")).toBe("busy");
  });

  it("unwraps the object form used by object-reference payloads", () => {
    expect(statusText({ type: "busy" })).toBe("busy");
  });

  it("falls back to idle for unknown shapes", () => {
    expect(statusText(null)).toBe("idle");
    expect(statusText({})).toBe("idle");
    expect(statusText({ type: 7 })).toBe("idle");
  });
});

describe("errorMessage", () => {
  it("reads every supported error shape", () => {
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage({ message: "boom" })).toBe("boom");
    expect(errorMessage({ data: { message: "boom" } })).toBe("boom");
  });

  it("prefers the direct message over the nested one", () => {
    expect(errorMessage({ message: "outer", data: { message: "inner" } })).toBe(
      "outer",
    );
  });

  it("returns undefined when nothing readable is present", () => {
    expect(errorMessage(undefined)).toBeUndefined();
    expect(errorMessage({})).toBeUndefined();
    expect(errorMessage({ data: {} })).toBeUndefined();
    expect(errorMessage(123)).toBeUndefined();
  });
});

describe("isAbortedError — прерывание отличается от поломки", () => {
  // Ради этого различия функция и заведена: до неё прерванный ход показывался
  // красной плашкой «Ошибка API: проверьте тариф модели или ключ», потому что
  // `MessageAbortedError` текста не несёт и подставлялся запасной. Совет
  // проверить ключ после нажатия на вариант ответа уводил в сторону от того,
  // что произошло.
  it("узнаёт прерывание по имени класса ошибки", () => {
    expect(isAbortedError({ name: "MessageAbortedError" })).toBe(true);
    expect(isAbortedError({ data: { name: "MessageAbortedError" } })).toBe(
      true,
    );
  });

  it("узнаёт прерывание по тексту, когда имени нет", () => {
    // Ровно эта форма пришла со стенда 01.08.2026: движок кладёт в ошибку
    // короткое «Aborted», поэтому красная плашка показывала именно его.
    expect(isAbortedError({ message: "Aborted" })).toBe(true);
    expect(isAbortedError("Aborted")).toBe(true);
    expect(isAbortedError({ message: "request aborted" })).toBe(true);
    expect(isAbortedError({ data: { message: "ход прерван" } })).toBe(true);
  });

  it("не считает прерыванием настоящую ошибку движка", () => {
    expect(isAbortedError({ name: "ProviderAuthError" })).toBe(false);
    expect(isAbortedError({ message: "insufficient credits" })).toBe(false);
    expect(isAbortedError(undefined)).toBe(false);
    expect(isAbortedError(null)).toBe(false);
    expect(isAbortedError({})).toBe(false);
  });
});
