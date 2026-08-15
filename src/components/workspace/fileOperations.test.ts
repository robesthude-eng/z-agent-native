/**
 * Этап 3.1: решения об операциях над файлами воркспейса.
 *
 * Перебор, а не случаи. Три свойства держат панель от порчи данных:
 * операция в черновике невозможна ни при каком пути, область действия
 * переименования и удаления совпадает до одного узла, а переехавший редактор
 * не сохраняет старый путь.
 */
import { describe, expect, it } from "vitest";
import {
  editorAfterRename,
  editorClosedByDelete,
  isInsideOrSelf,
  operationGate,
  panelButtonGate,
  renamePlan,
  uploadBatches,
  uploadPercent,
  workspaceOperable,
} from "@/components/workspace/fileOperations";

const SESSIONS = [
  null,
  undefined,
  "",
  "tmp_1",
  "tmp_abc",
  "ses_0510fc093ffee6RAfLWAq7BMB9",
  "local_1",
  "произвольная-строка",
];

const PATHS = [
  "",
  "a.ts",
  "src",
  "src/a.ts",
  "src/lib/a.ts",
  "project-ui",
  "project-ui/src/main.tsx",
  "project-ui-notes.md",
  "src-gen/a.ts",
  "путь/с/кириллицей.txt",
];

describe("разрешена ли операция", () => {
  it("настоящая сессия разрешает и причины не называет", () => {
    const g = operationGate("ses_1");
    expect(g.allowed).toBe(true);
    expect(g.reason).toBeNull();
    expect(g.explanation).toBe("");
  });

  it("всякий отказ назван словами", () => {
    // То же требование, что I-31 предъявляет к неактивной кнопке: молчаливый
    // отказ выглядит поломкой интерфейса, а не запретом.
    for (const s of SESSIONS) {
      const g = operationGate(s);
      if (g.allowed) continue;
      expect(`${String(s)}:${g.explanation.length > 0}`).toBe(
        `${String(s)}:true`,
      );
      expect(g.reason).not.toBeNull();
    }
  });

  it("две причины отказа — разные строки", () => {
    // «Выберите чат» тому, кто уже в черновике, — совет невыполнимый.
    expect(operationGate(null).explanation).not.toBe(
      operationGate("tmp_1").explanation,
    );
  });

  it("черновик не разрешает операцию ни при каком имени", () => {
    for (const s of ["tmp_", "tmp_1", "tmp_ses_1", "tmp_очень_длинный"]) {
      expect(`${s}:${operationGate(s).reason}`).toBe(`${s}:draft_chat`);
    }
  });

  it("обе формы шлюза дают один ответ на всяком входе", () => {
    // `operationGate` объясняет отказ, `workspaceOperable` сужает тип. Правило
    // одно: разойдись они — кнопка была бы активна там, где операция молча
    // ничего не делает, или наоборот.
    for (const s of SESSIONS) {
      expect(`${String(s)}:${workspaceOperable(s)}`).toBe(
        `${String(s)}:${operationGate(s).allowed}`,
      );
    }
  });
});

describe("свойства кнопки панели", () => {
  it("активная кнопка сохраняет свою подпись", () => {
    expect(
      panelButtonGate({ sessionId: "ses_1", fallbackTitle: "Новый файл" }),
    ).toEqual({ disabled: false, title: "Новый файл" });
  });

  it("неактивная кнопка никогда не молчит", () => {
    // Требование I-31 к кнопкам runtime-возможностей; редактор не повод его
    // нарушать. Перебор по всем сессиям и обоим состояниям занятости.
    for (const s of SESSIONS) {
      for (const busy of [true, false]) {
        const g = panelButtonGate({
          sessionId: s,
          fallbackTitle: "Загрузить папку",
          busy,
          busyTitle: "Идёт загрузка",
        });
        if (!g.disabled) continue;
        expect(`${String(s)}/${busy}:${g.title.length > 0}`).toBe(
          `${String(s)}/${busy}:true`,
        );
      }
    }
  });

  it("причина отсутствия чата важнее идущей загрузки", () => {
    // Порядок значим: идущая загрузка кончится сама, отсутствие чата — нет.
    expect(
      panelButtonGate({
        sessionId: null,
        fallbackTitle: "Загрузить папку",
        busy: true,
        busyTitle: "Идёт загрузка",
      }).title,
    ).toBe(operationGate(null).explanation);
  });

  it("неактивность совпадает со шлюзом, когда занятости нет", () => {
    for (const s of SESSIONS) {
      const g = panelButtonGate({ sessionId: s, fallbackTitle: "т" });
      expect(`${String(s)}:${g.disabled}`).toBe(
        `${String(s)}:${!operationGate(s).allowed}`,
      );
    }
  });
});

describe("граница поддерева", () => {
  it("узел содержит сам себя", () => {
    for (const p of PATHS.filter(Boolean)) {
      expect(`${p}:${isInsideOrSelf(p, p)}`).toBe(`${p}:true`);
    }
  });

  it("похожее имя в поддерево не входит", () => {
    // Запрет по голому префиксу захватил бы соседа: ровно эта ошибка уже
    // закрыта тестом для `editability`.
    expect(isInsideOrSelf("project-ui-notes.md", "project-ui")).toBe(false);
    expect(isInsideOrSelf("src-gen/a.ts", "src")).toBe(false);
  });

  it("пустой узел не содержит ничего", () => {
    // Иначе корень «содержал» бы весь воркспейс, и любая операция закрывала
    // бы редактор.
    for (const p of PATHS) {
      expect(`${p}:${isInsideOrSelf(p, "")}`).toBe(`${p}:false`);
    }
  });
});

describe("план переименования", () => {
  it("имя достраивается до пути от родителя", () => {
    expect(renamePlan("src/lib/a.ts", "b.ts")).toEqual({
      kind: "rename",
      to: "src/lib/b.ts",
    });
    expect(renamePlan("a.ts", "b.ts")).toEqual({ kind: "rename", to: "b.ts" });
  });

  it("пробелы по краям не создают другого файла", () => {
    expect(renamePlan("src/a.ts", "  b.ts  ")).toEqual({
      kind: "rename",
      to: "src/b.ts",
    });
  });

  it("два повода ничего не делать различимы", () => {
    expect(renamePlan("src/a.ts", "   ")).toEqual({
      kind: "noop",
      reason: "empty",
    });
    expect(renamePlan("src/a.ts", "a.ts")).toEqual({
      kind: "noop",
      reason: "unchanged",
    });
  });

  it("обход каталогов доходит до сервера как есть", () => {
    // Закрепляется намеренно. Настоящая граница — buildSafeWorkspacePath
    // (I-02), и она закрыта тестом на сервере. Клиент, который сам себе
    // охрана, создаёт иллюзию, из-за которой серверную проверку однажды
    // сочтут лишней.
    expect(renamePlan("src/a.ts", "../b.ts")).toEqual({
      kind: "rename",
      to: "src/../b.ts",
    });
  });
});

describe("что становится с открытым редактором", () => {
  it("переименование файла ведёт редактор за ним", () => {
    expect(editorAfterRename("src/a.ts", "src/a.ts", "src/b.ts")).toBe(
      "src/b.ts",
    );
  });

  it("переименование ПАПКИ ведёт редактор за файлом внутри", () => {
    // Прежнее условие сравнивало пути целиком, поэтому редактор оставался на
    // мёртвом пути, а следующее сохранение воссоздавало и файл, и папку.
    expect(editorAfterRename("src/lib/a.ts", "src", "lib")).toBe(
      "lib/lib/a.ts",
    );
    expect(editorAfterRename("src/a.ts", "src", "app")).toBe("app/a.ts");
  });

  it("чужой файл не трогается", () => {
    expect(editorAfterRename("docs/a.md", "src", "app")).toBeNull();
    expect(editorAfterRename("src-gen/a.ts", "src", "app")).toBeNull();
    expect(editorAfterRename(null, "src", "app")).toBeNull();
  });

  it("после переезда старого пути не остаётся", () => {
    // Свойство, ради которого функция и заведена: сохранение берёт путь из
    // редактора, и остаток прежнего пути означал бы запись мимо файла.
    for (const active of PATHS) {
      for (const from of PATHS) {
        const next = editorAfterRename(active, from, "переехало");
        if (next === null) continue;
        expect(`${active}|${from}|${next.startsWith("переехало")}`).toBe(
          `${active}|${from}|true`,
        );
      }
    }
  });

  it("удаление ПАПКИ закрывает открытый внутри файл", () => {
    expect(editorClosedByDelete("src/lib/a.ts", "src")).toBe(true);
    expect(editorClosedByDelete("src/a.ts", "src/a.ts")).toBe(true);
  });

  it("область переименования и удаления совпадает до одного узла", () => {
    // Главное свойство пары. Два условия одного смысла разошлись бы молча:
    // одна операция трогала бы редактор, вторая — нет, и объяснить это
    // пользователю было бы нечем.
    for (const active of PATHS) {
      for (const target of PATHS) {
        const moved = editorAfterRename(active, target, "к") !== null;
        const closed = editorClosedByDelete(active, target);
        expect(`${active}|${target}|${moved}`).toBe(
          `${active}|${target}|${closed}`,
        );
      }
    }
  });
});

describe("загрузка папки", () => {
  it("доля всегда целая и в пределах шкалы", () => {
    const cases: [number, number][] = [
      [0, 0],
      [0, 10],
      [5, 10],
      [10, 10],
      [20, 10],
      [-1, 10],
      [1, 3],
      [Number.NaN, 10],
      [1, Number.NaN],
      [1, 0],
      [1, -5],
    ];
    for (const [done, total] of cases) {
      const p = uploadPercent(done, total);
      expect(
        `${done}/${total}:${Number.isInteger(p) && p >= 0 && p <= 100}`,
      ).toBe(`${done}/${total}:true`);
    }
  });

  it("нулевой знаменатель даёт ноль, а не NaN", () => {
    // NaN в ширине полосы прогресса убирает полосу в момент старта загрузки.
    expect(uploadPercent(0, 0)).toBe(0);
  });

  it("батчи склеиваются обратно в исходный список", () => {
    // Потерянный при разбиении файл не заметил бы никто: загрузка всё равно
    // отчиталась бы успехом.
    for (const n of [0, 1, 19, 20, 21, 41]) {
      const files = Array.from({ length: n }, (_, i) => i);
      for (const size of [1, 7, 20, 100]) {
        const batches = uploadBatches(files, size);
        expect(`${n}/${size}:${batches.flat().join(",")}`).toBe(
          `${n}/${size}:${files.join(",")}`,
        );
        expect(batches.every((b) => b.length <= size && b.length > 0)).toBe(
          true,
        );
      }
    }
  });

  it("негодный размер батча не даёт бесконечного цикла", () => {
    expect(uploadBatches([1, 2, 3], 0)).toEqual([[1], [2], [3]]);
    expect(uploadBatches([1, 2, 3], -5)).toEqual([[1], [2], [3]]);
  });
});
