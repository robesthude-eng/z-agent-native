import { describe, expect, it } from "vitest";
import {
  isNetworkishError,
  PROMPT_DELIVERED_MS,
  promptRetryDecision,
} from "./promptRetry";

/**
 * Когда повтор отправки промпта спасает, а когда создаёт дубликат.
 *
 * Правило жило внутри пятисотстрочного `send()` и не проверялось ничем, хотя
 * цена ошибки уже была заплачена однажды: слепой повтор отправлял второй
 * промпт, движок прерывал текущий ход и брался за дубль.
 */

const decide = (over: Partial<Parameters<typeof promptRetryDecision>[0]>) =>
  promptRetryDecision({
    message: "Failed to fetch",
    elapsedMs: 100,
    attempt: 0,
    retries: 2,
    ...over,
  });

describe("isNetworkishError", () => {
  it.each([
    ["Failed to fetch", "Chrome"],
    ["NetworkError when attempting to fetch resource", "Firefox"],
    ["Load failed", "Safari"],
    ["socket hang up", "Node"],
    ["read ECONNRESET", "Node"],
    ["503 Service Unavailable", "сервер"],
    ["upstream timed out", "прокси"],
  ])("%s — %s", (message) => {
    expect(isNetworkishError(message)).toBe(true);
  });

  it("регистр не важен", () => {
    expect(isNetworkishError("FAILED TO FETCH")).toBe(true);
    expect(isNetworkishError("EConnReset")).toBe(true);
  });

  it.each([
    "Unauthorized",
    "Invalid JSON body.",
    "session not found",
    "",
  ])("не сетевая: %s", (message) => {
    expect(isNetworkishError(message)).toBe(false);
  });
});

describe("поздний обрыв считается доставкой", () => {
  it("сетевая ошибка после порога — повтор запрещён", () => {
    expect(decide({ elapsedMs: PROMPT_DELIVERED_MS })).toBe("assume-delivered");
    expect(decide({ elapsedMs: PROMPT_DELIVERED_MS + 60_000 })).toBe(
      "assume-delivered",
    );
  });

  it("запрет сильнее оставшихся попыток", () => {
    // Главное утверждение файла. Поменяй местами проверку порога и проверку
    // «попытки ещё есть» — и вернётся ровно тот дефект, ради которого порог
    // заводили: соединение оборвалось через минуту, промпт давно на сервере,
    // а клиент шлёт его второй раз.
    expect(
      decide({ elapsedMs: PROMPT_DELIVERED_MS, attempt: 0, retries: 5 }),
    ).toBe("assume-delivered");
  });

  it("несетевая ошибка после порога — обычный отказ, а не «доставлено»", () => {
    expect(
      decide({ message: "Unauthorized", elapsedMs: PROMPT_DELIVERED_MS }),
    ).toBe("fail");
  });
});

describe("ранний сбой повторяем", () => {
  it("сетевая ошибка до порога — retry", () => {
    expect(decide({ elapsedMs: PROMPT_DELIVERED_MS - 1 })).toBe("retry");
    expect(decide({ elapsedMs: 0 })).toBe("retry");
  });

  it("последняя попытка — fail, а не бесконечный retry", () => {
    expect(decide({ attempt: 2, retries: 2 })).toBe("fail");
    expect(decide({ attempt: 1, retries: 2 })).toBe("retry");
  });

  it("нулевое число повторов: первая же ошибка — отказ", () => {
    expect(decide({ attempt: 0, retries: 0 })).toBe("fail");
  });
});

describe("несетевые ошибки не повторяются вовсе", () => {
  it("повтор их не починит", () => {
    expect(decide({ message: "Invalid JSON body.", elapsedMs: 10 })).toBe(
      "fail",
    );
    expect(decide({ message: "", elapsedMs: 10 })).toBe("fail");
  });
});
