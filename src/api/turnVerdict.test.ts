import { describe, expect, it } from "vitest";
import {
  dispositionOf,
  indicatorFor,
  isSettled,
  parseTurnState,
  STUCK_ACTION,
  STUCK_NOTICE,
  sendBlockReason,
  TURN_DISPOSITIONS,
  type TurnProjection,
  undefinedStatePresentation,
} from "./turnVerdict";

/**
 * Решение «что этот вердикт означает для интерфейса».
 *
 * Единственная часть этапа 1.4c, которую можно проверить без стора, сети и
 * браузера, — и поэтому именно она вынесена в отдельный модуль. Остальное
 * (ожидание финала, статусы, обработка ошибок) живёт в `messagesSlice` и
 * проверяется его тестами.
 *
 * Инварианты контракта: I-30 (UI не вычисляет завершение сам) и I-32 (любое
 * неопределённое состояние имеет спокойное представление) — оба закрыты
 * частично. Здесь проверено, что `stuck` не считается завершением и несёт текст
 * и действие; вывода в интерфейс пока нет, его место в `TurnCard`.
 */

const turn = (over: Partial<TurnProjection> = {}): TurnProjection => ({
  turnId: "msg_1",
  lifecycle: "running",
  verdict: null,
  since: 1,
  reason: null,
  ...over,
});

describe("что делать интерфейсу", () => {
  it.each([
    ["draft", "busy"],
    ["queued", "busy"],
    ["submitting", "busy"],
    ["running", "busy"],
    ["reconciling", "busy"],
  ] as const)("«%s» — работа идёт (%s)", (lifecycle, expected) => {
    // reconciling намеренно считается работой, а не отдельным видимым
    // состоянием: сверка длится секунды и в половине случаев кончается
    // возвратом в running. Показывать её значило бы мигать статусом на каждом
    // промежуточном маркере.
    expect(dispositionOf(turn({ lifecycle }))).toBe(expected);
  });

  it.each([
    "waiting_permission",
    "waiting_user_input",
  ] as const)("«%s» — ход ждёт человека", (lifecycle) => {
    expect(dispositionOf(turn({ lifecycle }))).toBe("waiting");
  });

  it("завершение и отмена освобождают интерфейс", () => {
    expect(dispositionOf(turn({ lifecycle: "completed" }))).toBe("settled");
    expect(dispositionOf(turn({ lifecycle: "cancelled" }))).toBe("settled");
  });

  it("ошибка освобождает интерфейс, но отличается от успеха", () => {
    expect(dispositionOf(turn({ lifecycle: "failed" }))).toBe("failed");
  });

  it("отсутствие хода — свободно", () => {
    expect(dispositionOf(null)).toBe("settled");
  });
});

describe("stuck не считается завершением", () => {
  it("остаётся незакрытым", () => {
    // Главное отличие от прежнего поведения: раньше истечение
    // предохранительного таймаута снимало busy, то есть «мы не знаем»
    // выдавалось за «всё готово».
    expect(dispositionOf(turn({ lifecycle: "stuck" }))).toBe("stuck");
    expect(isSettled(turn({ lifecycle: "stuck" }))).toBe(false);
  });

  it("а завершённые и провалившиеся — считаются", () => {
    expect(isSettled(turn({ lifecycle: "completed" }))).toBe(true);
    expect(isSettled(turn({ lifecycle: "cancelled" }))).toBe(true);
    expect(isSettled(turn({ lifecycle: "failed" }))).toBe(true);
  });

  it("работа и ожидание — не завершение", () => {
    expect(isSettled(turn({ lifecycle: "running" }))).toBe(false);
    expect(isSettled(turn({ lifecycle: "reconciling" }))).toBe(false);
    expect(isSettled(turn({ lifecycle: "waiting_permission" }))).toBe(false);
  });
});

describe("разбор ответа сервера", () => {
  it("читает проекцию хода", () => {
    expect(
      parseTurnState({
        turn: {
          turnId: "act_1",
          lifecycle: "running",
          verdict: null,
          since: 42,
          reason: "no completion signal",
        },
        orchestrator: true,
      }),
    ).toEqual({
      orchestrator: true,
      turn: {
        turnId: "act_1",
        lifecycle: "running",
        verdict: null,
        since: 42,
        reason: "no completion signal",
      },
    });
  });

  it("отсутствие активного хода — это ответ, а не ошибка", () => {
    expect(parseTurnState({ turn: null, orchestrator: true })).toEqual({
      turn: null,
      orchestrator: true,
    });
  });

  it("сервер без оркестратора отмечен явно", () => {
    // Клиент обязан это увидеть: вердикта не будет никогда, и молча ждать
    // значило бы повесить интерфейс на рассогласовании конфигурации.
    const parsed = parseTurnState({ turn: null, orchestrator: false });
    expect(parsed?.orchestrator).toBe(false);
  });

  it("неузнанный ответ означает «данных нет», а не исключение", () => {
    // Маршрута может ещё не быть — тогда прокси отдаст что-то от движка.
    // Ронять из-за этого отправку сообщения нельзя.
    for (const junk of [
      null,
      undefined,
      42,
      "строка",
      {},
      { verdict: "completed" },
      { turn: 42 },
      { turn: { lifecycle: "running" } },
      { turn: { turnId: "act_1" } },
    ]) {
      expect(parseTurnState(junk)).toBeNull();
    }
  });

  it("необязательные поля терпимы к пропускам", () => {
    const parsed = parseTurnState({
      turn: { turnId: "act_1", lifecycle: "stuck" },
    });
    expect(parsed?.turn).toMatchObject({
      turnId: "act_1",
      lifecycle: "stuck",
      verdict: null,
      since: 0,
      reason: null,
    });
    expect(parsed?.orchestrator).toBe(false);
  });
});

/**
 * I-32: неопределённое состояние названо словами и предлагает действие.
 *
 * Прежняя формулировка — «имеет спокойное представление» — проверке не
 * поддавалась: критерия у слова «спокойное» не было, и инвариант числился
 * закрытым наполовину без всякого способа это оценить.
 */
describe("представление неопределённого состояния (I-32)", () => {
  it("набор диспозиций зафиксирован", () => {
    // Тип живёт только во время сборки: добавленное шестое значение прошло бы
    // мимо любого теста. Список зафиксирован, поэтому новая диспозиция
    // обязывает решить, как она показывается.
    expect([...TURN_DISPOSITIONS]).toEqual([
      "busy",
      "waiting",
      "settled",
      "failed",
      "stuck",
    ]);
  });

  it("неопределённой является ровно одна диспозиция", () => {
    const undefinedOnes = TURN_DISPOSITIONS.filter((d) =>
      undefinedStatePresentation(d),
    );
    expect(undefinedOnes).toEqual(["stuck"]);
  });

  it("у неопределённого состояния есть и текст, и действие, оба непустые", () => {
    const shown = undefinedStatePresentation("stuck");
    expect(shown).not.toBeNull();
    expect(shown?.notice.trim().length).toBeGreaterThan(0);
    expect(shown?.action.trim().length).toBeGreaterThan(0);
  });

  it("определённые состояния ничего не объясняют", () => {
    for (const d of TURN_DISPOSITIONS) {
      if (d === "stuck") continue;
      expect(undefinedStatePresentation(d), d).toBeNull();
    }
  });

  it("неопределённое состояние не считается завершением", () => {
    // Главный случай инварианта: «мы не знаем» не должно выглядеть как «готово».
    expect(isSettled(turn({ lifecycle: "stuck" }))).toBe(false);
    expect(dispositionOf(turn({ lifecycle: "stuck" }))).toBe("stuck");
  });
});

/**
 * Проекция диспозиции в индикатор (этап 3.2).
 *
 * Три решения здесь согласованы отдельно, потому что видимы пользователю:
 * ожидание показывает `InterruptionBar`, а не индикатор; `reconciling` не имеет
 * своего вида; `stuck` называется словами и предлагает действие.
 */
describe("indicatorFor", () => {
  it("определён на каждой диспозиции", () => {
    // Диспозиция без своего вида проходила бы молча и не показывала ничего.
    for (const d of TURN_DISPOSITIONS) {
      const shown = indicatorFor(d);
      expect(shown, d).toBeTruthy();
      expect(
        ["hidden", "working", "unresolved", "unknown"],
        `${d} → ${shown.kind}`,
      ).toContain(shown.kind);
    }
  });

  it("работа показывается", () => {
    expect(indicatorFor("busy")).toEqual({ kind: "working" });
  });

  it("ожидание индикатором не показывается — у него свой диалог", () => {
    expect(indicatorFor("waiting")).toEqual({ kind: "hidden" });
  });

  it("исходы скрывают индикатор", () => {
    expect(indicatorFor("settled")).toEqual({ kind: "hidden" });
    expect(indicatorFor("failed")).toEqual({ kind: "hidden" });
  });

  it("неопределённость называется словами и предлагает действие", () => {
    const shown = indicatorFor("stuck");
    expect(shown.kind).toBe("unresolved");
    if (shown.kind !== "unresolved") return;
    expect(shown.notice).toBe(STUCK_NOTICE);
    expect(shown.action).toBe(STUCK_ACTION);
  });

  it("текст для stuck берётся из одного места", () => {
    // Иначе он заведётся в двух и разойдётся.
    const shown = indicatorFor("stuck");
    const source = undefinedStatePresentation("stuck");
    if (shown.kind !== "unresolved" || !source) throw new Error("нет данных");
    expect(shown.notice).toBe(source.notice);
    expect(shown.action).toBe(source.action);
  });

  it("отсутствие проекции — не «скрыть», а «не знаю»", () => {
    // После перезагрузки страницы поллер вердикта не запущен: он живёт внутри
    // send(). Если бы null означал «скрыть», индикатор исчезал бы посреди
    // идущего ответа — то есть ровно та ложь про завершение, от которой
    // избавлялись.
    expect(indicatorFor(null)).toEqual({ kind: "unknown" });
  });

  it("ровно одна диспозиция показывает неопределённость", () => {
    const unresolved = TURN_DISPOSITIONS.filter(
      (d) => indicatorFor(d).kind === "unresolved",
    );
    expect(unresolved).toEqual(["stuck"]);
  });

  it("ожидание — единственное, что запрещает отправку (2.1)", () => {
    // Пока агент ждёт человека, отправка начинала бы ВТОРОЙ ход при
    // приостановленном первом — тот самый разрыв непрерывности, который этап
    // 2.1 и запрещает.
    expect(sendBlockReason("waiting")).toBeTruthy();
    for (const d of TURN_DISPOSITIONS) {
      if (d === "waiting") continue;
      expect(sendBlockReason(d), d).toBeNull();
    }
  });

  it("во время работы отправлять можно — это привычная очередь", () => {
    expect(sendBlockReason("busy")).toBeNull();
  });

  it("без проекции запрета нет: с выключенным оркестратором ничего не меняется", () => {
    expect(sendBlockReason(null)).toBeNull();
  });

  it("оба вида ожидания дают одну причину", () => {
    // Разница между «ждёт разрешения» и «ждёт ответа» пользователю здесь не
    // важна: важно, что ход не продолжится. Что спрашивают — видно в самом
    // прерывании.
    expect(dispositionOf(turn({ lifecycle: "waiting_permission" }))).toBe(
      "waiting",
    );
    expect(dispositionOf(turn({ lifecycle: "waiting_user_input" }))).toBe(
      "waiting",
    );
  });

  it("reconciling попадает в работу, а не в отдельный вид", () => {
    // Согласованное решение: сверка длится секунды и в половине случаев
    // кончается возвратом в running — отдельный ярлык мигал бы.
    expect(dispositionOf(turn({ lifecycle: "reconciling" }))).toBe("busy");
    expect(indicatorFor("busy")).toEqual({ kind: "working" });
  });
});
