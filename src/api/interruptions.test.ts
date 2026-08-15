/**
 * Контрактные тесты единой формы прерывания (этап 2.1).
 *
 * Инварианты контракта: I-16 (ход, ждущий человека, не считается зависшим) и
 * I-32 (неопределённое состояние названо словами).
 *
 * Модуль подключён — полосой `src/components/InterruptionBar.tsx`, — но за
 * флагом `VITE_INTERRUPTION_BAR`, выключенным по умолчанию. Пока он выключен,
 * работают прежние показы, и эти тесты доказывают свойства функций, а не
 * поведение приложения. Ровно так же оговорены I-30 и I-31: строка называет
 * файл и тут же называет флаг, иначе «проверено» читалось бы как «работает у
 * пользователя».
 *
 * Главное, что здесь проверяется, — не разбор полей, а ОДНА вещь: отмена хода
 * возможна ровно в одной ветке, она названа значением и о ней предупреждают.
 * Прежде это было следствием порядка вызовов внутри `useCallback`, то есть
 * тем, чего тест увидеть не может.
 */

import { describe, expect, it } from "vitest";
import {
  activeQuestion,
  answerAsMessage,
  answerFromFeed,
  BAR_COLLAPSE_LINES,
  barPresentation,
  barWarning,
  batchReplyPlan,
  feedTrace,
  hasQuestionPart,
  type Interruption,
  isBarQuestionPart,
  isInterruptedQuestionPart,
  isLongForBar,
  normalizePermission,
  normalizeQuestion,
  optionsLayout,
  planCancelsTurn,
  QUESTION_TOOL,
  questionFeedLine,
  replyPlan,
  replyTextAfterCall,
  replyTransport,
  replyWarning,
} from "./interruptions";

/**
 * Доступ к элементу с явной ошибкой вместо `undefined`.
 *
 * В проекте включён `noUncheckedIndexedAccess`, и `xs[0]` имеет тип
 * `T | undefined`. Заглушить это восклицательным знаком значило бы получить
 * `undefined` внутрь утверждения и падение с невнятным сообщением; здесь
 * отсутствие элемента — сразу отдельная ошибка с индексом.
 */
const at = <T>(xs: readonly T[], i: number): T => {
  const v = xs[i];
  if (v === undefined) throw new Error(`нет элемента ${i}`);
  return v;
};

const present = (tool: string, input: unknown) => ({
  action: `Запустить ${tool}`,
  detail:
    input && typeof input === "object" && "command" in input
      ? String((input as { command: unknown }).command)
      : undefined,
});

describe("normalizePermission", () => {
  it("даёт три варианта, из них ровно один — отказ", () => {
    const i = normalizePermission({ id: "per_1", tool: "bash" }, present);
    expect(i.options).toHaveLength(3);
    expect(i.options.filter((o) => o.denial)).toHaveLength(1);
    expect(i.options.find((o) => o.denial)?.value).toBe("reject");
  });

  it("первым идёт безопасный вариант — только этот вызов", () => {
    const i = normalizePermission({ id: "per_1", tool: "bash" }, present);
    expect(at(i.options, 0).value).toBe("once");
  });

  it("значения кнопок — ровно словарь движка", () => {
    const i = normalizePermission({ id: "per_1", tool: "bash" }, present);
    expect(i.options.map((o) => o.value)).toEqual(["once", "always", "reject"]);
  });

  it("произвольный ответ на разрешение невозможен", () => {
    const i = normalizePermission({ id: "per_1", tool: "bash" }, present);
    expect(i.allowCustom).toBe(false);
  });

  it("деталь берётся из перевода нагрузки", () => {
    const i = normalizePermission(
      { id: "per_1", tool: "bash", input: { command: "rm -rf /tmp/x" } },
      present,
    );
    expect(i.detail).toBe("rm -rf /tmp/x");
  });

  it("отсутствие имени инструмента не роняет разбор", () => {
    const i = normalizePermission({ id: "per_1" }, present);
    expect(i.prompt).toBe("Запустить tool");
  });

  it("отсутствие id даёт null, а не пустую строку", () => {
    const i = normalizePermission({ tool: "bash" }, present);
    expect(i.id).toBeNull();
  });
});

describe("normalizeQuestion", () => {
  it("вариант-строка и вариант-объект дают одинаковую форму", () => {
    const a = normalizeQuestion({ options: ["Да"] }, null);
    const b = normalizeQuestion({ options: [{ label: "Да" }] }, null);
    expect(at(a.options, 0)).toEqual(at(b.options, 0));
  });

  it("отправляется надпись, а не id варианта", () => {
    const i = normalizeQuestion(
      { options: [{ label: "Согласен", id: "opt_7" }] },
      null,
    );
    expect(at(i.options, 0).value).toBe("Согласен");
  });

  it("синонимы полей движка читаются", () => {
    const i = normalizeQuestion(
      { text: "Продолжать?", options: [{ text: "Да", desc: "поехали" }] },
      null,
    );
    expect(i.prompt).toBe("Продолжать?");
    expect(at(i.options, 0).label).toBe("Да");
    expect(at(i.options, 0).description).toBe("поехали");
  });

  it("произвольный ответ разрешён по умолчанию и запрещается явно", () => {
    expect(normalizeQuestion({}, null).allowCustom).toBe(true);
    expect(
      normalizeQuestion({ allowCustomResponse: false }, null).allowCustom,
    ).toBe(false);
    expect(normalizeQuestion({ allowCustom: false }, null).allowCustom).toBe(
      false,
    );
  });

  it("мусорная нагрузка даёт пустое прерывание, а не исключение", () => {
    for (const junk of [null, undefined, 42, "строка", []]) {
      const i = normalizeQuestion(junk, null);
      expect(i.kind).toBe("question");
      expect(i.options).toEqual([]);
    }
  });

  it("у вопроса и разрешения одна форма", () => {
    const p = normalizePermission({ id: "per_1", tool: "bash" }, present);
    const q = normalizeQuestion({ question: "Как быть?" }, "que_1");
    expect(Object.keys(q).sort()).toEqual(Object.keys(p).sort());
  });
});

describe("replyPlan — разрешение", () => {
  const perm = (): Interruption =>
    normalizePermission({ id: "per_1", tool: "bash" }, present);

  it("каждый из трёх ответов уходит по протоколу разрешений", () => {
    for (const v of ["once", "always", "reject"]) {
      expect(replyPlan(perm(), [v])).toEqual({
        transport: "permission",
        id: "per_1",
        response: v,
      });
    }
  });

  it("слово вне словаря не отправляется вовсе", () => {
    const plan = replyPlan(perm(), ["allow"]);
    expect(plan.transport).toBe("none");
  });

  it("без идентификатора отправлять некуда, и это сказано словами", () => {
    const i = normalizePermission({ tool: "bash" }, present);
    const plan = replyPlan(i, ["once"]);
    expect(plan.transport).toBe("none");
    if (plan.transport === "none") expect(plan.reason).not.toBe("");
  });

  it("НИ ОДИН ответ на разрешение не отменяет ход", () => {
    const cases = ["once", "always", "reject", "allow", "", "   "];
    for (const v of cases) {
      expect(planCancelsTurn(replyPlan(perm(), [v]))).toBe(false);
    }
  });
});

describe("replyPlan — вопрос", () => {
  it("подтверждённый вопрос уходит по своему протоколу и ход остаётся целым", () => {
    const i = normalizeQuestion({ question: "Как быть?" }, null);
    const plan = replyPlan(i, ["Да"], { pendingQuestionId: "que_9" });
    expect(plan).toEqual({
      transport: "question",
      id: "que_9",
      answers: [["Да"]],
    });
    expect(planCancelsTurn(plan)).toBe(false);
  });

  it("идентификатор из прерывания годится, если серверного нет", () => {
    const i = normalizeQuestion({ question: "Как быть?" }, "que_1");
    const plan = replyPlan(i, ["Да"]);
    expect(plan.transport).toBe("question");
    if (plan.transport === "question") expect(plan.id).toBe("que_1");
  });

  it("несколько выбранных вариантов уходят одним вопросом, а не несколькими", () => {
    const i = normalizeQuestion({ question: "Что включить?" }, "que_1");
    const plan = replyPlan(i, ["A", "B"]);
    if (plan.transport !== "question") throw new Error("не тот транспорт");
    expect(plan.answers).toHaveLength(1);
    expect(at(plan.answers, 0)).toEqual(["A", "B"]);
  });

  it("без подтверждённого request id ответ НЕ превращается в новый ход", () => {
    const i = normalizeQuestion({ question: "Как быть?" }, null);
    const plan = replyPlan(i, ["Да"], { pendingQuestionId: null });
    expect(plan.transport).toBe("none");
    expect(planCancelsTurn(plan)).toBe(false);
    if (plan.transport === "none") expect(plan.reason).toContain("подтверждён");
  });

  it("ответ на вопрос никогда не предупреждает об отмене хода", () => {
    const i = normalizeQuestion({ question: "Как быть?" }, null);
    expect(replyWarning(replyPlan(i, ["Да"]))).toBeNull();
  });

  it("там, где ход не отменяется, предупреждения нет", () => {
    const i = normalizeQuestion({ question: "Как быть?" }, "que_1");
    expect(replyWarning(replyPlan(i, ["Да"]))).toBeNull();
  });

  it("пустой ответ не отправляется и хода не отменяет", () => {
    const i = normalizeQuestion({ question: "Как быть?" }, null);
    for (const v of [[], [""], ["  "], ["", "   "]]) {
      const plan = replyPlan(i, v);
      expect(plan.transport).toBe("none");
      expect(planCancelsTurn(plan)).toBe(false);
    }
  });
});

describe("ответы на прерывания не создают второй ход", () => {
  const all: Array<[string, Interruption, string[], string | null]> = [
    [
      "разрешение",
      normalizePermission({ id: "per_1", tool: "bash" }, present),
      ["once"],
      "que_1",
    ],
    [
      "отказ разрешения",
      normalizePermission({ id: "per_1", tool: "bash" }, present),
      ["reject"],
      null,
    ],
    [
      "вопрос подтверждённый",
      normalizeQuestion({ question: "?" }, null),
      ["Да"],
      "que_1",
    ],
    [
      "вопрос ещё без request id",
      normalizeQuestion({ question: "?" }, null),
      ["Да"],
      null,
    ],
  ];

  it("ни один план ответа не отменяет текущий turn", () => {
    for (const [name, i, a, pid] of all) {
      expect(`${name}:${planCancelsTurn(replyPlan(i, a, { pendingQuestionId: pid }))}`).toBe(
        `${name}:false`,
      );
    }
  });

  it("ни один план не показывает старое предупреждение об abort", () => {
    for (const [name, i, a, pid] of all) {
      expect(`${name}:${replyWarning(replyPlan(i, a, { pendingQuestionId: pid }))}`).toBe(
        `${name}:null`,
      );
    }
  });
});

describe("answerAsMessage", () => {
  it("подставляет вопрос впереди, иначе ответ не к чему привязать", () => {
    const i = normalizeQuestion({ question: "Продолжать?" }, null);
    expect(answerAsMessage(i, ["Да"])).toBe("Продолжать?: Да");
  });

  it("без вопроса отдаёт только ответ, без ведущего двоеточия", () => {
    const i = normalizeQuestion({}, null);
    expect(answerAsMessage(i, ["Да"])).toBe("Да");
  });
});

describe("barPresentation — что показывает полоса", () => {
  const perm = () =>
    normalizePermission({ id: "per_1", tool: "bash" }, present);
  const quest = (text = "Как быть?") =>
    normalizeQuestion({ question: text }, "que_1");

  it("пустая очередь — полосы нет", () => {
    expect(barPresentation([])).toEqual({
      visible: false,
      active: null,
      queued: 0,
      collapsible: false,
    });
  });

  it("показывает одно прерывание за раз и считает остальные", () => {
    // Полоса перекрывает переписку: очередь карточек перекрыла бы её тем
    // сильнее, чем больше агент спрашивает.
    const r = barPresentation([quest("A"), quest("B"), quest("C")]);
    expect(r.active?.prompt).toBe("A");
    expect(r.queued).toBe(2);
  });

  it("разрешение идёт раньше вопроса, даже если пришло позже", () => {
    // Разрешение блокирует конкретный вызов инструмента: ответ на вопрос без
    // него всё равно не сдвинет ход с места.
    const r = barPresentation([quest(), perm()]);
    expect(r.active?.kind).toBe("permission");
    expect(r.queued).toBe(1);
  });

  it("короткий вопрос не предлагает «показать целиком»", () => {
    // Кнопка у короткого текста обещает скрытое, которого нет.
    expect(barPresentation([quest("Да или нет?")]).collapsible).toBe(false);
  });

  it("длинный вопрос сворачивается", () => {
    expect(barPresentation([quest("я".repeat(400))]).collapsible).toBe(true);
  });

  it("деталь учитывается вместе с вопросом, а не отдельно", () => {
    // У разрешения весь объём в детали: команда бывает длиннее вопроса.
    const long = normalizePermission(
      { id: "per_1", tool: "bash", input: { command: "x".repeat(400) } },
      present,
    );
    expect(barPresentation([long]).collapsible).toBe(true);
  });
});

describe("isLongForBar", () => {
  it("считает переносы строк, а не только длину", () => {
    // Четыре коротких строки не помещаются так же, как один длинный абзац.
    const shortLines = Array(BAR_COLLAPSE_LINES + 1)
      .fill("да")
      .join("\n");
    expect(isLongForBar(shortLines)).toBe(true);
  });

  it("ровно предел ещё помещается", () => {
    const atLimit = Array(BAR_COLLAPSE_LINES).fill("да").join("\n");
    expect(isLongForBar(atLimit)).toBe(false);
  });

  it("пустой текст не считается длинным", () => {
    expect(isLongForBar("")).toBe(false);
  });

  it("длинная одиночная строка переносится и потому длинна", () => {
    expect(isLongForBar("я".repeat(1000))).toBe(true);
    expect(isLongForBar("я".repeat(10))).toBe(false);
  });
});

describe("feedTrace — что остаётся в ленте", () => {
  const q = () => normalizeQuestion({ question: "Продолжать?" }, "que_1");

  it("до ответа в ленте пусто: вопрос живёт в полосе", () => {
    // Две копии одного действия — два места, куда можно нажать, и ни одного
    // очевидного.
    expect(feedTrace(q(), null)).toBeNull();
    expect(feedTrace(q(), [])).toBeNull();
  });

  it("после ответа остаётся строка «вопрос — ответ»", () => {
    expect(feedTrace(q(), ["Да"])).toBe("Продолжать? — Да");
  });

  it("несколько выбранных вариантов перечисляются", () => {
    expect(feedTrace(q(), ["A", "B"])).toBe("Продолжать? — A, B");
  });

  it("вопрос без текста не даёт ведущего тире", () => {
    expect(feedTrace(normalizeQuestion({}, null), ["Да"])).toBe("Да");
  });
});

describe("activeQuestion — где взять вопрос для полосы", () => {
  const part = (over = {}) => ({
    type: "tool",
    tool: QUESTION_TOOL,
    callID: "call_1",
    state: { status: "running", input: { question: "Как быть?" } },
    ...over,
  });
  const msg = (...parts: unknown[]) => ({ parts });

  it("находит вопрос, ждущий ответа", () => {
    const r = activeQuestion([msg(part())]);
    expect(r?.interruptions).toHaveLength(1);
    expect(at(r?.interruptions ?? [], 0).prompt).toBe("Как быть?");
    expect(r?.callId).toBe("call_1");
  });

  it("берёт ПОСЛЕДНИЙ вопрос, а не первый", () => {
    // Вопросов за ход бывает несколько, и ждёт ответа последний. Поиск с
    // начала показывал бы в полосе давно отвеченный.
    const r = activeQuestion([
      msg(
        part({ state: { status: "running", input: { question: "Первый" } } }),
      ),
      msg(
        part({ state: { status: "running", input: { question: "Второй" } } }),
      ),
    ]);
    expect(at(r?.interruptions ?? [], 0).prompt).toBe("Второй");
  });

  it("завершённый вопрос ответа не ждёт", () => {
    // Полоса на решённом вопросе предлагала бы ответить на то, что агент уже
    // получил и по чему уже пошёл дальше.
    for (const status of ["completed", "error"]) {
      expect(activeQuestion([msg(part({ state: { status } }))])).toBeNull();
    }
  });

  it("строковый статус старых версий читается так же", () => {
    expect(activeQuestion([msg(part({ state: "running" }))])).not.toBeNull();
    expect(activeQuestion([msg(part({ state: "completed" }))])).toBeNull();
  });

  it("`pending` — это тоже ожидание", () => {
    expect(activeQuestion([msg(part({ state: "pending" }))])).not.toBeNull();
  });

  it("другой инструмент вопросом не считается", () => {
    expect(activeQuestion([msg(part({ tool: "bash" }))])).toBeNull();
  });

  it("имя-объект во время стрима вопросом НЕ считается", () => {
    // Ошибиться дороже в одну сторону: лишняя полоса перекрывает переписку и
    // требует действия, которого не ждут.
    expect(
      activeQuestion([msg(part({ tool: { messageID: "m", callID: "c" } }))]),
    ).toBeNull();
  });

  it("список вопросов отдаётся ЦЕЛИКОМ, а не первым элементом", () => {
    const r = activeQuestion([
      msg(
        part({
          state: {
            status: "running",
            input: { questions: [{ question: "A" }, { question: "B" }] },
          },
        }),
      ),
    ]);
    expect(r?.interruptions.map((i) => i.prompt)).toEqual(["A", "B"]);
  });

  it("нагрузка в устаревшем поле input тоже читается", () => {
    const r = activeQuestion([
      msg({ type: "tool", tool: QUESTION_TOOL, input: { question: "Старый" } }),
    ]);
    expect(at(r?.interruptions ?? [], 0).prompt).toBe("Старый");
  });

  it("мусор в сообщениях не роняет разбор", () => {
    for (const junk of [
      [],
      [{}],
      [{ parts: null }],
      [{ parts: "строка" }],
      [{ parts: [null, 5, "x"] }],
      [{ parts: [{ type: "text", text: "привет" }] }],
    ]) {
      expect(() => activeQuestion(junk as never)).not.toThrow();
      expect(activeQuestion(junk as never)).toBeNull();
    }
  });

  it("отсутствие callID не мешает найти вопрос", () => {
    const r = activeQuestion([msg(part({ callID: undefined }))]);
    expect(r?.callId).toBeNull();
    expect(at(r?.interruptions ?? [], 0).prompt).toBe("Как быть?");
  });

  it("имя инструмента совпадает с серверным", () => {
    // Разойдись они — сервер считал бы ход ждущим человека, а интерфейс не
    // показывал бы, чего ждут. Серверная сторона: QUESTION_TOOL в
    // server/turn-orchestrator.mjs.
    expect(QUESTION_TOOL).toBe("question");
  });
});

describe("isBarQuestionPart — одно условие на два места", () => {
  const part = (over = {}) => ({
    type: "tool",
    tool: QUESTION_TOOL,
    state: { status: "running", input: { question: "Как быть?" } },
    ...over,
  });

  it("вопрос, ждущий ответа, забирает полоса", () => {
    expect(isBarQuestionPart(part())).toBe(true);
  });

  it("отвеченный вопрос остаётся в ленте историей", () => {
    for (const status of ["completed", "error"]) {
      expect(isBarQuestionPart(part({ state: { status } }))).toBe(false);
    }
  });

  it("не-вопрос лента не отдаёт", () => {
    expect(isBarQuestionPart(part({ tool: "bash" }))).toBe(false);
    expect(isBarQuestionPart({ type: "text", text: "привет" })).toBe(false);
  });

  it("мусор не считается вопросом и не роняет проверку", () => {
    for (const junk of [null, undefined, 0, "", [], "строка"]) {
      expect(() => isBarQuestionPart(junk)).not.toThrow();
      expect(isBarQuestionPart(junk)).toBe(false);
    }
  });

  it("ЧТО ЗАБИРАЕТ ПОЛОСА, ТО ЛЕНТА И ПРЯЧЕТ — условие одно", () => {
    // Смысл этого теста — не набор случаев, а совпадение двух точек решения.
    // Разойдись они, вопрос исчез бы из ленты, не появившись в полосе, и ход
    // ждал бы ответа, которого не видно нигде. Такое не отлаживается по жалобе
    // «иногда ничего не происходит».
    const cases = [
      part(),
      part({ state: "running" }),
      part({ state: "pending" }),
      part({ state: { status: "completed" } }),
      part({ state: { status: "error" } }),
      part({ tool: "bash" }),
      part({ tool: { messageID: "m", callID: "c" } }),
      part({ type: "text" }),
    ];
    for (const c of cases) {
      const takenByBar = activeQuestion([{ parts: [c] }]) !== null;
      const hiddenFromFeed = isBarQuestionPart(c);
      expect(`${JSON.stringify(c.state)}:${takenByBar}`).toBe(
        `${JSON.stringify(c.state)}:${hiddenFromFeed}`,
      );
    }
  });
});

describe("replyTransport и barWarning — предупредить ДО ответа", () => {
  const perm = () =>
    normalizePermission({ id: "per_1", tool: "bash" }, present);
  const quest = (id: string | null = null) =>
    normalizeQuestion({ question: "Как быть?" }, id);

  it("путь ответа известен ещё до выбора варианта", () => {
    expect(replyTransport(perm())).toBe("permission");
    expect(replyTransport(quest("que_1"))).toBe("question");
    expect(replyTransport(quest(null))).toBe("none");
    expect(replyTransport(normalizePermission({ tool: "bash" }, present))).toBe(
      "none",
    );
  });

  it("подтверждение с сервера перевешивает отсутствие id у прерывания", () => {
    expect(replyTransport(quest(null), { pendingQuestionId: "que_9" })).toBe(
      "question",
    );
  });

  it("предупреждение в полосе совпадает с предупреждением по плану", () => {
    // Два источника одного текста разошлись бы молча: в полосе написано одно,
    // а отправляется другое.
    const cases: Array<[Interruption, string | null]> = [
      [perm(), null],
      [perm(), "que_9"],
      [quest("que_1"), null],
      [quest(null), "que_9"],
      [quest(null), null],
    ];
    for (const [i, pending] of cases) {
      const ctx = { pendingQuestionId: pending };
      const viaPlan = replyWarning(replyPlan(i, ["Да"], ctx));
      expect(barWarning(i, ctx)).toBe(viaPlan);
    }
  });

  it("предупреждение не зависит от того, что выбрано", () => {
    // Прежде оно считалось подстановкой выдуманного ответа в `replyPlan` —
    // приём, который сломался бы молча, начни функция проверять содержимое.
    const i = quest(null);
    const w = barWarning(i);
    for (const answer of [["Да"], ["Нет"], ["длинный свободный ответ"]]) {
      expect(replyWarning(replyPlan(i, answer))).toBe(w);
    }
  });

  it("транспорт плана совпадает с обещанным транспортом", () => {
    const cases: Array<[Interruption, string | null]> = [
      [perm(), null],
      [quest("que_1"), null],
      [quest(null), "que_9"],
      [quest(null), null],
    ];
    for (const [i, pending] of cases) {
      const ctx = { pendingQuestionId: pending };
      const value = i.kind === "permission" ? "once" : "Да";
      expect(replyPlan(i, [value], ctx).transport).toBe(replyTransport(i, ctx));
    }
  });
});

describe("batchReplyPlan — вопросы одного вызова уходят вместе", () => {
  const three = () => [
    normalizeQuestion({ question: "Стек?", options: ["React", "Vue"] }, null),
    normalizeQuestion({ question: "База?", options: ["PG", "SQLite"] }, null),
    normalizeQuestion({ question: "Тесты?", options: ["Да", "Нет"] }, null),
  ];

  it("по протоколу отправляет ВСЕ ответы, а не только первый", () => {
    const plan = batchReplyPlan(three(), [["React"], ["PG"], ["Да"]], {
      pendingQuestionId: "que_1",
    });
    expect(plan.transport).toBe("question");
    if (plan.transport !== "question") throw new Error("не тот транспорт");
    // Внешний уровень — вопрос. Одиночная отправка заполняла его наполовину, и
    // вопросы со второго по последний оставались без ответа.
    expect(plan.answers).toEqual([["React"], ["PG"], ["Да"]]);
  });

  it("позиции сохраняются, даже если на вопрос не ответили", () => {
    // Сдвиг превратил бы ответ на третий вопрос в ответ на второй, и заметить
    // это можно было бы только по действиям агента.
    const plan = batchReplyPlan(three(), [["React"], [], ["Да"]], {
      pendingQuestionId: "que_1",
    });
    if (plan.transport !== "question") throw new Error("не тот транспорт");
    expect(plan.answers).toEqual([["React"], [], ["Да"]]);
  });

  it("без pending request id пакет остаётся на карточке и ничего не шлёт", () => {
    const plan = batchReplyPlan(three(), [["React"], ["PG"], ["Да"]]);
    expect(plan.transport).toBe("none");
    expect(planCancelsTurn(plan)).toBe(false);
    if (plan.transport === "none") expect(plan.reason).toContain("подтверждён");
  });

  it("частично заполненный пакет тоже ждёт тот же pending request", () => {
    const plan = batchReplyPlan(three(), [["React"], [], ["Да"]]);
    expect(plan.transport).toBe("none");
    expect(planCancelsTurn(plan)).toBe(false);
  });

  it("пустой пакет ничего не отправляет", () => {
    expect(batchReplyPlan([], []).transport).toBe("none");
    expect(batchReplyPlan(three(), [[], [], []]).transport).toBe("none");
  });

  it("разрешения пакетом не отправляются", () => {
    // У каждого свой идентификатор: пакет означал бы, что второе разрешение
    // молча ушло с ответом первого.
    const perms = [
      normalizePermission({ id: "per_1", tool: "bash" }, present),
      normalizePermission({ id: "per_2", tool: "write" }, present),
    ];
    const plan = batchReplyPlan(perms, [["once"], ["once"]]);
    expect(plan.transport).toBe("none");
  });

  it("одиночный ответ — тот же код, что и пакет из одного", () => {
    // Написанные отдельно, они разошлись бы молча: правку внесли бы в одну
    // ветку, а инвариант отмены хода проверяется на другой.
    const one = normalizeQuestion({ question: "Стек?" }, null);
    for (const pid of ["que_1", null]) {
      const ctx = { pendingQuestionId: pid };
      expect(replyPlan(one, ["React"], ctx)).toEqual(
        batchReplyPlan([one], [["React"]], ctx),
      );
    }
  });
});

describe("questionFeedLine — что остаётся в ленте", () => {
  const asked = () => normalizeQuestion({ question: "Стек?" }, null);

  it("без metadata ответа показывает только вопрос, без ссылки на user-message ниже", () => {
    const line = questionFeedLine(asked(), null);
    expect(line.text).toBe("Стек?");
    expect(line.note).toBe("");
  });

  it("ответ из metadata tool-call показывается в той же строке", () => {
    const line = questionFeedLine(asked(), ["React"]);
    expect(line.text).toBe(feedTrace(asked(), ["React"]));
    expect(line.note).toBe("");
  });

  it("вопрос без текста всё равно назван словами", () => {
    // Пустая строка в ленте — это I-32: неопределённость, показанная пустотой.
    expect(questionFeedLine(normalizeQuestion({}, null), null).text).toBe(
      "Вопрос агента",
    );
  });
});

describe("hasQuestionPart — почему ход оборвался", () => {
  const part = (state: unknown) => ({
    type: "tool",
    tool: QUESTION_TOOL,
    state,
  });

  it("узнаёт вопрос в ЛЮБОМ состоянии, а не только ждущий", () => {
    // Условие `isBarQuestionPart` здесь не годится: оно про «ждёт ответа
    // сейчас», а причину обрыва читают, когда вопрос уже отвечен.
    for (const state of [
      "running",
      { status: "error" },
      { status: "completed" },
    ]) {
      expect(hasQuestionPart({ parts: [part(state)] })).toBe(true);
    }
  });

  it("не находит вопроса там, где его нет", () => {
    expect(hasQuestionPart({ parts: [{ type: "tool", tool: "bash" }] })).toBe(
      false,
    );
    expect(hasQuestionPart({ parts: [{ type: "text" }] })).toBe(false);
    expect(hasQuestionPart({})).toBe(false);
    expect(hasQuestionPart({ parts: "нет" })).toBe(false);
  });
});

describe("isInterruptedQuestionPart — оборванный вопрос не ошибка", () => {
  const q = (state: unknown) => ({
    type: "tool",
    tool: QUESTION_TOOL,
    state,
  });

  it("узнаёт вопрос, оборванный ответом на него самого", () => {
    // Наблюдалось на стенде 01.08.2026: после нажатия на вариант ответа
    // цепочка помечалась красным «error» рядом с плашкой о прерывании.
    expect(isInterruptedQuestionPart(q({ status: "error" }))).toBe(true);
    expect(isInterruptedQuestionPart(q("error"))).toBe(true);
  });

  it("не трогает ни ждущий вопрос, ни отвеченный, ни чужую ошибку", () => {
    expect(isInterruptedQuestionPart(q({ status: "running" }))).toBe(false);
    expect(isInterruptedQuestionPart(q({ status: "completed" }))).toBe(false);
    expect(
      isInterruptedQuestionPart({
        type: "tool",
        tool: "bash",
        state: { status: "error" },
      }),
    ).toBe(false);
    expect(isInterruptedQuestionPart({ type: "text" })).toBe(false);
    expect(isInterruptedQuestionPart(null)).toBe(false);
  });

  it("не пересекается с предикатом активного вопроса", () => {
    // Одна часть не может быть одновременно «ждёт ответа» и «оборвана»:
    // иначе полоса показывала бы вопрос, который уже никого не ждёт.
    for (const state of [
      "running",
      "error",
      "completed",
      { status: "error" },
    ]) {
      const part = q(state);
      expect(isBarQuestionPart(part) && isInterruptedQuestionPart(part)).toBe(
        false,
      );
    }
  });
});

describe("answerFromFeed — выбор восстанавливается из ленты", () => {
  const q = normalizeQuestion(
    { question: "Что дальше?", options: ["Продолжить", "Завершить тест"] },
    null,
  );

  it("читает ответ там же, где его читает агент", () => {
    // Состояние компонента перезагрузку страницы не переживает, а лента
    // переживает: ответ ушёл сообщением, собранным `answerAsMessage`.
    expect(answerFromFeed(q, "Что дальше?: Завершить тест")).toEqual([
      "Завершить тест",
    ]);
    expect(answerFromFeed(q, answerAsMessage(q, ["Продолжить"]))).toEqual([
      "Продолжить",
    ]);
  });

  it("находит свою строку в пакетном ответе", () => {
    const other = normalizeQuestion({ question: "Стек?" }, null);
    const text = "Стек?: React\nЧто дальше?: Завершить тест";
    expect(answerFromFeed(q, text)).toEqual(["Завершить тест"]);
    expect(answerFromFeed(other, text)).toEqual(["React"]);
  });

  it("чужую реплику ответом не считает", () => {
    // Иначе в свёрнутой строке появился бы выбор, которого никто не делал:
    // после вопроса пользователь мог написать что угодно.
    expect(answerFromFeed(q, "стоп")).toBeNull();
    expect(answerFromFeed(q, "Другой вопрос?: Да")).toBeNull();
    expect(answerFromFeed(q, "")).toBeNull();
    expect(answerFromFeed(q, "Что дальше?:")).toBeNull();
  });

  it("несколько вариантов разбирает, свободный текст — нет", () => {
    // «да, но осторожно» — это один ответ, а не два выбора.
    expect(
      answerFromFeed(q, "Что дальше?: Продолжить, Завершить тест"),
    ).toEqual(["Продолжить", "Завершить тест"]);
    expect(answerFromFeed(q, "Что дальше?: да, но осторожно")).toEqual([
      "да, но осторожно",
    ]);
  });

  it("вопрос без текста ответа не получает", () => {
    // Привязать реплику не к чему, и угадывать нельзя.
    const blank = normalizeQuestion({}, null);
    expect(answerFromFeed(blank, "Завершить тест")).toEqual(["Завершить тест"]);
    expect(answerFromFeed(blank, "первая\nвторая")).toBeNull();
  });
});

describe("replyTextAfterCall — какая реплика была ответом", () => {
  const textOf = (m: { text?: string }) => m.text ?? "";
  const feed = [
    { role: "user", text: "спроси", parts: [] },
    {
      role: "assistant",
      text: "",
      parts: [{ type: "tool", tool: QUESTION_TOOL, callID: "call_1" }],
    },
    { role: "user", text: "Что дальше?: Завершить тест", parts: [] },
    { role: "assistant", text: "готово", parts: [] },
  ];

  it("берёт первую пользовательскую реплику после вызова", () => {
    expect(replyTextAfterCall(feed, "call_1", textOf)).toBe(
      "Что дальше?: Завершить тест",
    );
  });

  it("не путает вызовы и не берёт реплику ДО вопроса", () => {
    expect(replyTextAfterCall(feed, "call_2", textOf)).toBe("");
    expect(replyTextAfterCall(feed, null, textOf)).toBe("");
  });

  it("отдаёт пустое, пока ответа ещё нет", () => {
    expect(replyTextAfterCall(feed.slice(0, 2), "call_1", textOf)).toBe("");
  });
});

describe("optionsLayout — форма следует виду прерывания", () => {
  const question = (...labels: string[]) =>
    normalizeQuestion({ question: "?", options: labels }, null);

  it("вопрос всегда список, чем бы модель его ни заполнила", () => {
    // Прежняя версия считала по длине надписей, и одно и то же действие
    // становилось то списком, то рядом кнопок в зависимости от того, какие
    // слова подобрала модель. Интерфейс, меняющий форму от содержимого,
    // приходится узнавать заново каждый раз.
    expect(optionsLayout(question("Да", "Нет"))).toBe("list");
    expect(
      optionsLayout(question("Three.js + Rapier (Recommended)", "Phaser")),
    ).toBe("list");
    expect(optionsLayout(question("а", "б", "в", "г", "д"))).toBe("list");
  });

  it("разрешение остаётся рядом кнопок", () => {
    // Не выбор из равных, а решение с последствиями: три фиксированных
    // ответа, у которых есть порядок и есть отказ.
    const perm = normalizePermission({ id: "per_1", tool: "bash" }, present);
    expect(optionsLayout(perm)).toBe("actions");
  });

  it("форма не зависит от того, сколько вариантов пришло", () => {
    for (const n of [0, 1, 3, 9]) {
      const labels = Array.from({ length: n }, (_, i) => `в${i}`);
      expect(optionsLayout(question(...labels))).toBe("list");
    }
  });
});
