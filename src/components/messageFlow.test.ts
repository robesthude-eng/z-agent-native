/**
 * Тесты для src/components/messageFlow.ts
 *
 * Обе проверяемые здесь ошибки жили в интерфейсе и были видны только
 * глазами на телефоне: «Действия · 2 шага» разворачивались в одну строку, а
 * подряд идущие действия рисовались тремя отдельными цепочками без единого
 * слова текста между ними. Ни один тест их не ловил, потому что решения
 * лежали внутри `.tsx` и перебором не проверялись.
 */

import { describe, expect, test } from "vitest";
import type { Message, Part, ToolPart } from "../api/types";
import {
  flowParts,
  groupActivityRuns,
  groupParts,
  runStepCount,
  runToolParts,
} from "./messageFlow";

const tool = (id: string, name: string): Part =>
  ({ id, type: "tool", tool: name, state: { status: "completed" } }) as Part;
const text = (id: string, t: string): Part =>
  ({ id, type: "text", text: t }) as Part;
const stepStart = (id: string): Part => ({ id, type: "step-start" }) as Part;
const stepFinish = (id: string): Part => ({ id, type: "step-finish" }) as Part;
const reasoning = (id: string): Part =>
  ({ id, type: "reasoning", text: "думаю" }) as Part;

const msg = (id: string, parts: Part[]): Message =>
  ({ id, role: "assistant", parts }) as Message;

describe("runStepCount", () => {
  test("служебные границы хода шагами не считаются", () => {
    // Ровно тот случай со скриншота: в шапке стояло «2 шага», внутри была
    // одна строка «Edited file».
    const items = groupParts([stepStart("s1"), tool("t1", "edit")]);
    expect(runStepCount(items)).toBe(1);
  });

  test("число совпадает с тем, что видно после раскрытия", () => {
    const parts = [
      stepStart("s1"),
      tool("t1", "bash"),
      reasoning("r1"),
      tool("t2", "read"),
      stepFinish("s2"),
    ];
    const items = groupParts(parts);
    // Видно: bash, размышление, read — три строки.
    expect(runStepCount(items)).toBe(3);
  });

  test("склеенная группа вызовов считается по числу вызовов", () => {
    const items = groupParts([
      tool("t1", "bash"),
      tool("t2", "bash"),
      tool("t3", "bash"),
    ]);
    // groupParts склеил три вызова bash в одну группу — но шага всё равно три.
    expect(runStepCount(items)).toBe(3);
  });

  test("цепочка из одних только границ даёт ноль", () => {
    const items = groupParts([stepStart("s1"), stepFinish("s2")]);
    expect(runStepCount(items)).toBe(0);
  });
});

describe("flowParts", () => {
  test("ход из нескольких сообщений даёт одну цепочку, а не три", () => {
    // Движок присылает ход порциями. Пока цепочка строилась внутри
    // сообщения, здесь получалось три отдельных «Действия» подряд.
    const messages = [
      msg("m1", [stepStart("s1"), tool("t1", "edit")]),
      msg("m2", [stepStart("s2"), tool("t2", "bash")]),
      msg("m3", [stepStart("s3"), tool("t3", "grep")]),
    ];
    const flow = groupActivityRuns(groupParts(flowParts(messages)));
    const runs = flow.filter((f) => "kind" in f && f.kind === "activity");
    expect(runs.length).toBe(1);
  });

  test("в единственной цепочке видны все три действия", () => {
    const messages = [
      msg("m1", [stepStart("s1"), tool("t1", "edit")]),
      msg("m2", [stepStart("s2"), tool("t2", "bash")]),
      msg("m3", [stepStart("s3"), tool("t3", "grep")]),
    ];
    const items = groupParts(flowParts(messages));
    expect(runStepCount(items)).toBe(3);
    expect(runToolParts(items).map((p: ToolPart) => p.tool)).toEqual([
      "edit",
      "bash",
      "grep",
    ]);
  });

  test("текст между действиями цепочку по-прежнему разрывает", () => {
    // Это не побочный эффект склейки, а смысл: комментарий агента между
    // действиями — граница мысли, и её видно.
    const messages = [
      msg("m1", [tool("t1", "edit")]),
      msg("m2", [text("x1", "Теперь соберу проект.")]),
      msg("m3", [tool("t2", "bash"), tool("t3", "read")]),
    ];
    const flow = groupActivityRuns(groupParts(flowParts(messages)));
    const kinds = flow.map((f) =>
      "kind" in f && f.kind === "activity" ? "цепочка" : (f as Part).type,
    );
    expect(kinds).toEqual(["tool", "text", "цепочка"]);
  });

  test("порядок частей сохраняется через границы сообщений", () => {
    const messages = [
      msg("m1", [tool("t1", "a")]),
      msg("m2", [tool("t2", "b")]),
    ];
    expect(flowParts(messages).map((p) => p.id)).toEqual(["t1", "t2"]);
  });

  test("сообщение без частей не ломает склейку", () => {
    const messages = [
      msg("m1", [tool("t1", "a")]),
      { id: "m2", role: "assistant" } as Message,
      msg("m3", [tool("t2", "b")]),
    ];
    expect(flowParts(messages).map((p) => p.id)).toEqual(["t1", "t2"]);
  });
});

/**
 * Сценарий прямо со скриншота: три «Действия» подряд без единого слова
 * текста между ними — «Действия · 1 шаг», «Действия · 2 шага», «Действия ·
 * 2 шага». Должна быть одна цепочка на пять шагов.
 */
describe("невидимые части не разрывают цепочку", () => {
  test("три хода подряд склеиваются в одну цепочку на пять шагов", () => {
    const messages = [
      msg("m1", [stepStart("s1"), tool("t1", "grep"), text("e1", "")]),
      msg("m2", [
        stepStart("s2"),
        tool("t2", "read"),
        reasoning("r1"),
        text("e2", "   "),
      ]),
      msg("m3", [stepStart("s3"), tool("t3", "edit"), reasoning("r2")]),
    ];
    const flow = groupActivityRuns(groupParts(flowParts(messages)));
    const runs = flow.filter((f) => "kind" in f && f.kind === "activity");
    expect(runs.length).toBe(1);
    const run = runs[0] as { items: Part[] };
    expect(runStepCount(run.items)).toBe(5);
  });

  test("пустая текстовая часть не рисуется и не считается шагом", () => {
    const items = groupParts([tool("t1", "bash"), text("e1", "")]);
    expect(runStepCount(groupActivityRuns(items).flatMap(() => items))).toBe(2);
    // Через группировку пустой текст исчезает совсем.
    const flow = groupActivityRuns(items);
    expect(flow.length).toBe(1);
  });

  test("непустой текст цепочку по-прежнему разрывает", () => {
    const messages = [
      msg("m1", [tool("t1", "grep"), tool("t2", "read")]),
      msg("m2", [text("x1", "Теперь проверю в браузере.")]),
      msg("m3", [tool("t3", "edit"), tool("t4", "bash")]),
    ];
    const flow = groupActivityRuns(groupParts(flowParts(messages)));
    const runs = flow.filter((f) => "kind" in f && f.kind === "activity");
    expect(runs.length).toBe(2);
  });

  test("одиночное действие остаётся без обёртки", () => {
    // Служебная граница хода больше не раздувает цепочку до двух элементов,
    // и одиночный вызов снова рисуется компактной строкой — как и задумано.
    const flow = groupActivityRuns(
      groupParts(flowParts([msg("m1", [stepStart("s1"), tool("t1", "grep")])])),
    );
    expect(
      flow.filter((f) => "kind" in f && f.kind === "activity").length,
    ).toBe(0);
  });
});
