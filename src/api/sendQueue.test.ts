/**
 * Этап 2.4: решения очереди отправки.
 *
 * Проверяются свойства, а не случаи. Главных три, и каждое закрывает то, ради
 * чего очередь вообще переезжает на сервер:
 *   — сообщение не теряется НИ ПРИ КАКОМ отказе (метрика «потерянные из
 *     очереди сообщения», цель ноль);
 *   — ключ действия один и тот же на всём пути (очередь и реестр говорят об
 *     одном действии);
 *   — порядок показа совпадает с порядком отправки, а не обещает другой.
 */
import { describe, expect, it } from "vitest";
import {
  enqueuePlan,
  fallbackToLocal,
  mergeQueue,
  nextToSend,
  parseServerQueue,
  type QueueEntry,
  removalPlan,
} from "@/api/sendQueue";
import type { ProcessedFile } from "@/api/files";

const SID = "ses_real";
const srv = (actionId: string, text: string, position: number): QueueEntry => ({
  actionId,
  text,
  position,
  origin: "server",
});
const loc = (actionId: string, text: string): QueueEntry => ({
  actionId,
  text,
  position: null,
  origin: "local",
});
const attachment: ProcessedFile = {
  name: "diagram.png",
  size: 123,
  mime: "image/png",
  ext: "png",
  kind: "image",
  workspacePath: "uploads/diagram.png",
};

describe("куда класть сообщение", () => {
  it("настоящая сессия при включённом флаге — на сервер", () => {
    const plan = enqueuePlan("привет", SID, { enabled: true });
    expect(plan.kind).toBe("server");
  });

  it("черновик — всегда локально: сессии на сервере ещё нет", () => {
    const plan = enqueuePlan("привет", "tmp_1", { enabled: true });
    expect(plan.kind).toBe("local");
    expect(plan.kind === "local" && plan.why).toBe("draft_session");
  });

  it("чата нет вовсе — тоже локально, а не отказ", () => {
    const plan = enqueuePlan("привет", null, { enabled: true });
    expect(plan.kind).toBe("local");
  });

  it("выключенный флаг оставляет прежний путь", () => {
    const plan = enqueuePlan("привет", SID, { enabled: false });
    expect(plan.kind).toBe("local");
    expect(plan.kind === "local" && plan.why).toBe("flag_off");
  });

  // Принцип выката проверяется утверждением, а не обещанием: с выключенным
  // флагом исход не зависит от сессии вовсе.
  it("с выключенным флагом исход один на всех входах", () => {
    const kinds = new Set(
      [SID, "tmp_1", null, "", "ses_other"].map(
        (sid) => enqueuePlan("t", sid, { enabled: false }).kind,
      ),
    );
    expect([...kinds]).toEqual(["local"]);
  });
});

describe("сообщение не теряется", () => {
  it("отказ очереди превращается в локальную запись, а не в ошибку", () => {
    const plan = enqueuePlan("важное", SID, { enabled: true });
    const after = fallbackToLocal(plan);
    expect(after.kind).toBe("local");
    expect(after.kind === "local" && after.why).toBe("queue_unavailable");
  });

  it("текст и ключ переживают откат на локальный путь", () => {
    const plan = enqueuePlan("важное", SID, {
      enabled: true,
      actionId: "act_keepme",
    });
    const after = fallbackToLocal(plan);
    expect(after.text).toBe("важное");
    // Тот же ключ, а не новый: повторная отправка с новым ключом создала бы
    // второй ход — ровно тот фантомный дубль, ради которого заведён реестр.
    expect(after.actionId).toBe("act_keepme");
  });

  it("вложение переживает серверную очередь и локальный fallback", () => {
    const plan = enqueuePlan("", SID, {
      enabled: true,
      attachments: [{ ...attachment, dataUrl: "data:image/png;base64,AA==" }],
    });
    const after = fallbackToLocal(plan);
    expect(after.attachments).toEqual([attachment]);
  });

  it("откат идемпотентен: локальная запись остаётся собой", () => {
    const local = enqueuePlan("t", "tmp_1", { enabled: true });
    expect(fallbackToLocal(local)).toEqual(local);
  });
});

describe("что показывается", () => {
  it("серверные в порядке позиции, локальные следом", () => {
    const merged = mergeQueue(
      [srv("a", "второе", 2), srv("b", "первое", 1)],
      [loc("c", "ещё не принято")],
    );
    expect(merged.map((e) => e.actionId)).toEqual(["b", "a", "c"]);
  });

  it("подтверждённая запись не показывается дважды", () => {
    // Пока ответ на постановку идёт, запись живёт локально. После
    // подтверждения она обязана слиться, а не удвоиться.
    const merged = mergeQueue([srv("a", "текст", 1)], [loc("a", "текст")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.origin).toBe("server");
  });

  it("порядок показа совпадает с порядком отправки", () => {
    const merged = mergeQueue([srv("a", "1", 1), srv("b", "2", 2)], []);
    expect(nextToSend(merged, false)?.actionId).toBe("a");
  });

  it("во время работы агента не уходит ничего", () => {
    const merged = mergeQueue([srv("a", "1", 1)], []);
    expect(nextToSend(merged, true)).toBeNull();
  });

  it("за раз уходит ровно одна запись", () => {
    const merged = mergeQueue([srv("a", "1", 1), srv("b", "2", 2)], []);
    const next = nextToSend(merged, false);
    // Второй ход не заводится: следующая уйдёт, когда завершится начатый.
    expect(next?.actionId).toBe("a");
    expect(nextToSend(merged.slice(1), true)).toBeNull();
  });
});

describe("удаление по крестику", () => {
  it("серверная запись убирается запросом", () => {
    expect(removalPlan(srv("a", "t", 1), SID)).toEqual({
      kind: "server",
      sessionId: SID,
      actionId: "a",
    });
  });

  it("локальная — из состояния, без запроса", () => {
    expect(removalPlan(loc("a", "t"), SID)).toEqual({
      kind: "local",
      actionId: "a",
    });
  });

  it("серверная запись в черновике не даёт запроса с tmp_", () => {
    // Иначе DELETE ушёл бы на маршрут, который отвергает `tmp_`, и крестик
    // молча переставал бы работать.
    expect(removalPlan(srv("a", "t", 1), "tmp_1").kind).toBe("local");
  });
});

describe("разбор ответа сервера", () => {
  it("читает записи в форме маршрута", () => {
    const parsed = parseServerQueue({
      queue: [{ actionId: "a", payload: { text: "привет" }, position: 1 }],
    });
    expect(parsed).toEqual([
      { actionId: "a", text: "привет", position: 1, origin: "server" },
    ]);
  });

  it("мусорная запись пропускается, соседние остаются", () => {
    const parsed = parseServerQueue({
      queue: [
        { actionId: "a", payload: { text: "цел" }, position: 1 },
        { actionId: 42, payload: { text: "мусор" } },
        { actionId: "b", payload: {} },
        { actionId: "c", payload: { text: "тоже цел" }, position: 3 },
      ],
    });
    // Сломанный ответ не должен выглядеть как пустая очередь: разница между
    // «ничего не стоит» и «не смогли прочитать» видна пользователю сразу.
    expect(parsed.map((e) => e.actionId)).toEqual(["a", "c"]);
  });

  it("восстанавливает attachment-only запись из серверной очереди", () => {
    const parsed = parseServerQueue({
      queue: [
        {
          actionId: "with_file",
          payload: { text: "", attachments: [attachment] },
          position: 1,
        },
      ],
    });
    expect(parsed[0]?.attachments).toEqual([attachment]);
    expect(nextToSend(parsed, false)?.text).toBe("");
  });

  it("не роняется ни на чём", () => {
    for (const body of [
      null,
      undefined,
      {},
      { queue: "нет" },
      { queue: [] },
      7,
    ]) {
      expect(parseServerQueue(body)).toEqual([]);
    }
  });
});
