/**
 * Этап 3.2: вид части сообщения. Контрактный тест инварианта **I-33**.
 *
 * Проверяются свойства отображения, а не отдельные случаи. Их три, и первое
 * важнее остальных: функция ТОТАЛЬНА — часть не может исчезнуть молча.
 */
import { describe, expect, it } from "vitest";
import {
  isVisible,
  needsText,
  PART_PRESENTATIONS,
  type PartPresentation,
  presentationFor,
} from "@/api/partPresentation";

/** Входы, на которых функция обязана устоять. */
const HOSTILE: unknown[] = [
  null,
  undefined,
  0,
  1,
  "",
  "строка",
  [],
  {},
  { type: null },
  { type: 42 },
  { type: "" },
  { type: "text" },
  { type: "text", text: "" },
  { type: "text", text: "привет" },
  { type: "reasoning" },
  { type: "reasoning", text: "думаю" },
  { type: "tool" },
  { type: "attachment" },
  { type: "file" },
  { type: "stub", text: "должно скрыться" },
  { type: "step-start" },
  { type: "step-start", text: "шаг" },
  { type: "step-finish", text: "шаг" },
  { type: "step-reasoning", text: "шаг" },
  { type: "нечто-новое" },
  { type: "нечто-новое", text: "содержимое" },
  { type: "text", text: { вложенный: "объект" } },
];

describe("вид части выводится всегда", () => {
  it("любой вход даёт вид из набора и никогда undefined", () => {
    for (const input of HOSTILE) {
      const p = presentationFor(input);
      expect(`${JSON.stringify(input)} -> ${p}`).toBe(
        `${JSON.stringify(input)} -> ${p}`,
      );
      expect(PART_PRESENTATIONS).toContain(p);
    }
  });

  it("мусор не роняет и не бросает", () => {
    for (const input of HOSTILE) {
      expect(() => presentationFor(input)).not.toThrow();
    }
  });

  // Главное свойство этапа: незнакомый тип не исчезает. Движок волен завести
  // новый вид части, и «ничего не показали» означало бы потерянный кусок
  // ответа без единого признака, что он был.
  it("незнакомый тип с текстом показывается, а не теряется", () => {
    expect(presentationFor({ type: "нечто-новое", text: "содержимое" })).toBe(
      "fallback",
    );
    expect(isVisible("fallback")).toBe(true);
  });

  it("незнакомый тип без текста считается пустым, а не скрытым", () => {
    // Разница не косметическая: `hidden` значит «показывать не надо»,
    // `empty` — «показывать было бы что, но нечего». Слить их значит
    // потерять единственный признак пустой части.
    expect(presentationFor({ type: "нечто-новое" })).toBe("empty");
  });
});

describe("набор видов закрыт", () => {
  it("в наборе нет повторов", () => {
    expect(new Set(PART_PRESENTATIONS).size).toBe(PART_PRESENTATIONS.length);
  });

  it("каждый вид набора достижим хотя бы одним входом", () => {
    const reached = new Set(HOSTILE.map((h) => presentationFor(h)));
    const missing = PART_PRESENTATIONS.filter((p) => !reached.has(p));
    // Недостижимый вид — это либо мёртвая ветка, либо забытый вход в тесте.
    // И то и другое стоит увидеть падением, а не выяснять по жалобе.
    expect(missing).toEqual([]);
  });

  it("видимость определена на каждом виде", () => {
    for (const p of PART_PRESENTATIONS) {
      expect(typeof isVisible(p)).toBe("boolean");
      expect(typeof needsText(p)).toBe("boolean");
    }
  });

  it("невидимых видов ровно два и они названы", () => {
    const invisible = PART_PRESENTATIONS.filter((p) => !isVisible(p));
    expect(invisible).toEqual(["hidden", "empty"]);
  });
});

describe("текст обязателен ровно там, где без него нечего показать", () => {
  const pairs: [PartPresentation, unknown][] = [
    ["text", { type: "text", text: "" }],
    ["reasoning", { type: "reasoning" }],
    ["step", { type: "step-start" }],
    ["fallback", { type: "новое" }],
  ];

  it("вид, требующий текста, без текста становится пустым", () => {
    for (const [presentation, emptyInput] of pairs) {
      expect(needsText(presentation)).toBe(true);
      expect(`${presentation}:${presentationFor(emptyInput)}`).toBe(
        `${presentation}:empty`,
      );
    }
  });

  it("вид, не требующий текста, от текста не зависит", () => {
    // Инструмент, вложение и файл несут содержимое не в `text`, и требование
    // текста спрятало бы их целиком.
    for (const type of ["tool", "attachment", "file"]) {
      const withText = presentationFor({ type, text: "что-то" });
      const without = presentationFor({ type });
      expect(`${type}:${withText}`).toBe(`${type}:${without}`);
      expect(isVisible(without)).toBe(true);
    }
  });
});

describe("скрытое остаётся скрытым", () => {
  it("`stub` не показывается даже с текстом", () => {
    // Заглушка приходит раньше настоящей части и текст в ней бывает.
    expect(presentationFor({ type: "stub", text: "должно скрыться" })).toBe(
      "hidden",
    );
  });

  it("часть, которая вообще не объект, скрыта", () => {
    for (const input of [null, undefined, 7, "строка", true]) {
      expect(presentationFor(input)).toBe("hidden");
    }
  });
});

describe("текст из одних пробелов", () => {
  it("считается пустым: показывать в нём нечего", () => {
    expect(presentationFor({ type: "text", text: "   " })).toBe("empty");
    expect(presentationFor({ type: "text", text: "\n\n" })).toBe("empty");
    expect(presentationFor({ type: "text", text: "\t " })).toBe("empty");
  });

  it("и потому невидим — иначе рвал бы цепочку действий", () => {
    // Ровно причина, по которой «Действия» шли подряд тремя блоками без
    // единого слова между ними: часть ничего не рисовала, но группировка
    // о неё спотыкалась.
    expect(isVisible(presentationFor({ type: "text", text: " " }))).toBe(false);
  });

  it("текст с содержимым по краям остаётся видимым", () => {
    expect(presentationFor({ type: "text", text: "  привет  " })).toBe("text");
  });

  it("то же правило у размышлений и служебных шагов", () => {
    expect(presentationFor({ type: "reasoning", text: "  " })).toBe("empty");
    expect(presentationFor({ type: "step-start", text: "\n" })).toBe("empty");
  });
});
