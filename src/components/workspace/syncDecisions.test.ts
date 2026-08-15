/**
 * Этап 3.1: решения о синхронизации дерева.
 *
 * Главное свойство одно и проверяется перебором последовательностей: фоновый
 * опрос не отменяет ручную перезагрузку, а ручная отменяет всё, что было в
 * пути. До выноса это правило существовало комментарием.
 */
import { describe, expect, it } from "vitest";
import {
  acceptsResult,
  errorDisposition,
  type LoadKind,
  nextGeneration,
  POLL_INTERVAL_MS,
  shouldPoll,
} from "@/components/workspace/syncDecisions";

describe("поколения загрузки", () => {
  it("ручная перезагрузка отменяет всё, что было в пути", () => {
    const started = nextGeneration(0, "manual"); // 1
    const later = nextGeneration(started, "manual"); // 2
    expect(acceptsResult(started, later)).toBe(false);
    expect(acceptsResult(later, later)).toBe(true);
  });

  it("фоновый опрос не отменяет ручную перезагрузку", () => {
    // Тик таймера, пришедший через секунду после нажатия «Обновить», не должен
    // выбрасывать ответ, которого пользователь ждёт.
    const manual = nextGeneration(5, "manual"); // 6
    const afterBackground = nextGeneration(manual, "background"); // 6
    expect(acceptsResult(manual, afterBackground)).toBe(true);
  });

  it("фоновый результат выбрасывается, если между стартом и ответом было ручное обновление", () => {
    const bgStarted = 3;
    const current = nextGeneration(bgStarted, "manual"); // 4
    expect(acceptsResult(bgStarted, current)).toBe(false);
  });

  it("любая последовательность фоновых опросов поколение не двигает", () => {
    let gen = 7;
    for (let i = 0; i < 50; i++) gen = nextGeneration(gen, "background");
    expect(gen).toBe(7);
  });

  it("перебор последовательностей: принимается ровно то, что стартовало последним ручным", () => {
    const kinds: LoadKind[] = ["manual", "background"];
    for (const a of kinds) {
      for (const b of kinds) {
        for (const c of kinds) {
          let gen = 0;
          gen = nextGeneration(gen, a);
          const startedFirst = gen;
          gen = nextGeneration(gen, b);
          gen = nextGeneration(gen, c);
          const manualAfterFirst = [b, c].filter((k) => k === "manual").length;
          expect(`${a}${b}${c}:${acceptsResult(startedFirst, gen)}`).toBe(
            `${a}${b}${c}:${manualAfterFirst === 0}`,
          );
        }
      }
    }
  });
});

describe("когда опрашивать", () => {
  it("опрос идёт только при всех трёх условиях сразу", () => {
    // Перебор: любое выключенное условие обязано остановить опрос. Иначе
    // скрытая вкладка гоняла бы запросы к ФС по таймеру для каждого чата.
    for (const panelOpen of [true, false]) {
      for (const documentHidden of [true, false]) {
        for (const sessionReady of [true, false]) {
          const facts = { panelOpen, documentHidden, sessionReady };
          const expected = panelOpen && !documentHidden && sessionReady;
          expect(`${JSON.stringify(facts)}:${shouldPoll(facts)}`).toBe(
            `${JSON.stringify(facts)}:${expected}`,
          );
        }
      }
    }
  });

  it("интервал назван числом и осмыслен", () => {
    // «Порог забыли» и «порог такой» должны быть различимы.
    expect(POLL_INTERVAL_MS).toBe(8000);
  });
});

describe("судьба ошибки", () => {
  it("ручная показывает, фоновая молчит", () => {
    expect(errorDisposition("manual")).toBe("show");
    expect(errorDisposition("background")).toBe("swallow");
  });

  it("исходов ровно два и они разные", () => {
    // Слить их — значит либо молчать в ответ на нажатую кнопку, либо ронять
    // красную плашку поверх верного дерева из-за моргнувшей сети.
    const seen = new Set(
      (["manual", "background"] as LoadKind[]).map(errorDisposition),
    );
    expect(seen.size).toBe(2);
  });
});
