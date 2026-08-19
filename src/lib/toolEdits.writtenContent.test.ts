/**
 * Тесты для `extractWrittenContent` из src/lib/toolEdits.ts
 *
 * Карточка `write` показывала JSON вызова целиком: путь, содержимое и
 * служебные поля одной простынёй с экранированными переводами строк.
 * Прочитать в ней файл было нельзя — ни пока он пишется, ни после.
 *
 * Главное здесь — различие между «пишет, но пока пусто» и «файл не пишет
 * вовсе». Первое обязано показывать растущий текст, второе — плейсхолдер.
 * Спутать их значит либо потерять стриминг, либо повесить «Генерирует
 * содержимое…» над командой bash.
 */

import { describe, expect, test } from "vitest";
import type { Message, ToolPart } from "../api/types";
import { patchPartDelta } from "../store/helpers";
import { extractWrittenContent } from "./toolEdits";

describe("extractWrittenContent", () => {
  test("содержимое файла достаётся из `content`", () => {
    expect(
      extractWrittenContent({ filePath: "game.js", content: "const a = 1;" }),
    ).toBe("const a = 1;");
  });

  test("пустая строка — это «пишет, но пока ничего», а не «не пишет»", () => {
    // Содержимое приезжает дельтами: в первый миг строка пуста, но карточка
    // уже обязана показывать её, а не плейсхолдер.
    expect(extractWrittenContent({ filePath: "a.txt", content: "" })).toBe("");
  });

  test("недописанный текст возвращается как есть", () => {
    const partial = "function move(pi";
    expect(extractWrittenContent({ content: partial })).toBe(partial);
  });

  test("вызов без содержимого даёт null — только тут уместен плейсхолдер", () => {
    expect(extractWrittenContent({ command: "ls -la" })).toBeNull();
    expect(extractWrittenContent({})).toBeNull();
  });

  test("правка файла содержимым не считается", () => {
    // `newString` — половина пары «было/стало». Показать её как записанный
    // файл значило бы выдать кусок правки за весь файл; такие вызовы идут
    // в diff, а не сюда.
    expect(
      extractWrittenContent({ oldString: "a", newString: "b" }),
    ).toBeNull();
  });

  test("не-объект и пустой ввод не роняют разбор", () => {
    expect(extractWrittenContent(null)).toBeNull();
    expect(extractWrittenContent(undefined)).toBeNull();
    expect(extractWrittenContent("строка")).toBeNull();
    expect(extractWrittenContent(42)).toBeNull();
  });

  test("нестроковое содержимое игнорируется", () => {
    // Пока модель генерирует аргументы, поле может прийти чем угодно.
    expect(extractWrittenContent({ content: { chunk: 1 } })).toBeNull();
    expect(extractWrittenContent({ content: 123 })).toBeNull();
  });

  test("запасные имена поля тоже работают", () => {
    expect(extractWrittenContent({ contents: "x" })).toBe("x");
    expect(extractWrittenContent({ text: "y" })).toBe("y");
  });
});

/**
 * Сквозная проверка: дельта с сервера → часть в сторе → текст в карточке.
 *
 * Разбор и проводка проверялись по отдельности, и по отдельности оба были
 * верны — а на экране всё равно висел плейсхолдер. Поэтому здесь путь
 * целиком: без него «содержимое приходит» остаётся предположением.
 */
describe("стриминг содержимого файла: путь целиком", () => {
  const base = (): Message[] => [
    {
      id: "msg_1",
      role: "assistant",
      parts: [
        {
          id: "prt_1",
          type: "tool",
          tool: "write",
          state: { status: "running", input: { filePath: "game.js" } },
        } as ToolPart,
      ],
    } as Message,
  ];

  const contentOf = (messages: Message[]): string | null => {
    const part = messages[0]?.parts?.[0] as ToolPart | undefined;
    const state = part?.state as { input?: unknown } | undefined;
    return extractWrittenContent(state?.input);
  };

  test("текст дописывается дельтами, а не перезаписывается", () => {
    let msgs = base();
    for (const chunk of ["const ", "board ", "= []"]) {
      msgs = patchPartDelta(
        msgs,
        "msg_1",
        "prt_1",
        "state.input.content",
        chunk,
      );
    }
    expect(contentOf(msgs)).toBe("const board = []");
  });

  test("после первой дельты карточке уже есть что показать", () => {
    // Ровно тот момент, когда раньше висело «Генерирует содержимое…».
    expect(contentOf(base())).toBeNull();
    const after = patchPartDelta(
      base(),
      "msg_1",
      "prt_1",
      "state.input.content",
      "co",
    );
    expect(contentOf(after)).toBe("co");
  });

  test("путь файла дельтой содержимого не затирается", () => {
    const after = patchPartDelta(
      base(),
      "msg_1",
      "prt_1",
      "state.input.content",
      "x",
    );
    const part = after[0]?.parts?.[0] as ToolPart | undefined;
    const state = part?.state as { input?: { filePath?: string } } | undefined;
    expect(state?.input?.filePath).toBe("game.js");
  });
});
