import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FINAL_SETTLE_MS } from "../api/turnFinality";
import { TurnSettle } from "./turnSettle";

/**
 * Окно стабилизации финального маркера.
 *
 * Пока эти таймеры были модульной переменной внутри `messagesSlice.ts`, до них
 * нельзя было дотянуться иначе как через экспорт «для тестов», которым ни один
 * тест не пользовался. Проверяется здесь ровно то, ради чего окно и заведено:
 * маркер сам по себе ход НЕ закрывает, закрывает его тишина.
 */

let settle: TurnSettle;

beforeEach(() => {
  vi.useFakeTimers();
  settle = new TurnSettle();
});

afterEach(() => {
  settle.reset();
  vi.useRealTimers();
});

describe("взведение и тишина", () => {
  it("маркер сам по себе не закрывает ход — закрывает тишина", () => {
    const close = vi.fn();
    settle.arm("ses_1", close);

    // Ключевое утверждение: сразу после маркера ход ещё идёт.
    expect(close).not.toHaveBeenCalled();
    expect(settle.isPending("ses_1")).toBe(true);

    vi.advanceTimersByTime(FINAL_SETTLE_MS - 1);
    expect(close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(settle.isPending("ses_1")).toBe(false);
  });

  it("активность снимает отложенное закрытие", () => {
    const close = vi.fn();
    settle.arm("ses_1", close);
    settle.cancel("ses_1");

    vi.advanceTimersByTime(FINAL_SETTLE_MS * 3);
    expect(close).not.toHaveBeenCalled();
  });

  it("отмена несуществующего таймера — не ошибка", () => {
    expect(() => settle.cancel("ses_missing")).not.toThrow();
  });
});

describe("повторный маркер продлевает окно, а не заводит второй таймер", () => {
  it("второе взведение отменяет первое", () => {
    const first = vi.fn();
    const second = vi.fn();
    settle.arm("ses_1", first);

    vi.advanceTimersByTime(FINAL_SETTLE_MS - 10);
    settle.arm("ses_1", second);

    // Здесь сработал бы первый таймер, если бы взведение его не сняло — то
    // есть ход закрылся бы посреди продолжающейся работы агента.
    vi.advanceTimersByTime(20);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(settle.pendingCount).toBe(1);

    vi.advanceTimersByTime(FINAL_SETTLE_MS);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("сессии независимы", () => {
  it("закрытие одной не трогает другую", () => {
    const a = vi.fn();
    const b = vi.fn();
    settle.arm("ses_a", a);
    vi.advanceTimersByTime(FINAL_SETTLE_MS / 2);
    settle.arm("ses_b", b);
    expect(settle.pendingCount).toBe(2);

    vi.advanceTimersByTime(FINAL_SETTLE_MS / 2);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    expect(settle.isPending("ses_b")).toBe(true);

    vi.advanceTimersByTime(FINAL_SETTLE_MS);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("cancel одной сессии не снимает окно другой", () => {
    const a = vi.fn();
    const b = vi.fn();
    settle.arm("ses_a", a);
    settle.arm("ses_b", b);
    settle.cancel("ses_a");

    vi.advanceTimersByTime(FINAL_SETTLE_MS);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe("reset", () => {
  it("снимает все окна и ничего не вызывает", () => {
    const a = vi.fn();
    const b = vi.fn();
    settle.arm("ses_a", a);
    settle.arm("ses_b", b);
    settle.reset();

    expect(settle.pendingCount).toBe(0);
    vi.advanceTimersByTime(FINAL_SETTLE_MS * 2);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });
});
