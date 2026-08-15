import { beforeEach, describe, expect, it } from "vitest";
import { PermissionDedup } from "./permissionDedup";

/**
 * Дедупликация ответов на разрешения.
 *
 * Свойство, ради которого это существует: повторно доставленное SSE-событие
 * (переподключение стрима) НЕ должно приводить ко второму ответу. Второй ответ
 * сервер отвергает, обработчик ошибки возвращает запрос в очередь — и
 * пользователь видит карточку на действие, которое уже разрешено.
 */

let dedup: PermissionDedup;

beforeEach(() => {
  dedup = new PermissionDedup();
});

describe("claim", () => {
  it("первый раз занимает, второй — отказывает", () => {
    expect(dedup.claim("perm_1")).toBe(true);
    expect(dedup.claim("perm_1")).toBe(false);
    expect(dedup.claim("perm_1")).toBe(false);
  });

  it("разные разрешения независимы", () => {
    expect(dedup.claim("perm_1")).toBe(true);
    expect(dedup.claim("perm_2")).toBe(true);
    expect(dedup.claim("perm_1")).toBe(false);
    expect(dedup.claim("perm_2")).toBe(false);
  });

  it("повторная доставка того же события отвечает ровно один раз", () => {
    // Ровно тот сценарий, от которого защищаемся: стрим переподключился и
    // прислал permission.asked заново.
    const deliveries = ["perm_x", "perm_x", "perm_x"];
    const answered = deliveries.filter((id) => dedup.claim(id));
    expect(answered).toEqual(["perm_x"]);
  });
});

describe("wasAnswered", () => {
  it("не занимает разрешение сам", () => {
    expect(dedup.wasAnswered("perm_1")).toBe(false);
    // Проверка не должна расходовать право на ответ.
    expect(dedup.claim("perm_1")).toBe(true);
    expect(dedup.wasAnswered("perm_1")).toBe(true);
  });
});

describe("reset", () => {
  it("забывает всё", () => {
    dedup.claim("perm_1");
    dedup.reset();
    expect(dedup.wasAnswered("perm_1")).toBe(false);
    expect(dedup.claim("perm_1")).toBe(true);
  });
});
