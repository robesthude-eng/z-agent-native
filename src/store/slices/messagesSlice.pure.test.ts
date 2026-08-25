// Релиз 5: тесты чистых функций, вынесенных из send() (Релиз 4, батч 4b).
import { describe, expect, it } from "vitest";
import type { ProcessedFile } from "../../api/files";
import type { Message } from "../../api/types";
import {
  assistantFinishState,
  buildAttachmentParts,
  buildPromptParts,
} from "./messagesSlice";

function att(over: Partial<ProcessedFile>): ProcessedFile {
  return {
    name: "file.txt",
    size: 10,
    mime: "text/plain",
    ext: "txt",
    kind: "text",
    ...over,
  } as ProcessedFile;
}

describe("buildAttachmentParts", () => {
  it("маппит вложения в attachment-части оптимистичного сообщения", () => {
    const parts = buildAttachmentParts([
      att({ name: "a.png", kind: "image", dataUrl: "data:image/png;base64,x" }),
      att({ name: "b.zip", kind: "zip", workspacePath: "uploads/b.zip" }),
    ]);
    expect(parts).toEqual([
      {
        type: "attachment",
        name: "a.png",
        size: 10,
        kind: "image",
        path: undefined,
        dataUrl: "data:image/png;base64,x",
      },
      {
        type: "attachment",
        name: "b.zip",
        size: 10,
        kind: "zip",
        path: "uploads/b.zip",
        dataUrl: undefined,
      },
    ]);
  });

  it("пустой список вложений — пустой результат", () => {
    expect(buildAttachmentParts([])).toEqual([]);
  });
});

describe("buildPromptParts", () => {
  it("без вложений — только текст пользователя", () => {
    expect(buildPromptParts([], "привет")).toEqual([
      { type: "text", text: "привет" },
    ]);
  });

  it("вложение уходит отдельной typed-part, без base64 и служебного текста", () => {
    const parts = buildPromptParts(
      [
        att({
          name: "a.png",
          kind: "image",
          mime: "image/png",
          dataUrl: "data:image/png;base64,SHOULD_NOT_BE_SENT",
          workspacePath: "uploads/a.png",
        }),
      ],
      "посмотри картинку",
    );
    expect(parts).toEqual([
      {
        type: "attachment",
        name: "a.png",
        path: "uploads/a.png",
        size: 10,
        mime: "image/png",
        kind: "image",
      },
      { type: "text", text: "посмотри картинку" },
    ]);
    expect(JSON.stringify(parts)).not.toContain("SHOULD_NOT_BE_SENT");
    expect(JSON.stringify(parts)).not.toContain("<attachments>");
  });

  it("текстовый файл не инлайнится — агент получает только metadata/path", () => {
    const parts = buildPromptParts(
      [
        att({
          name: "мой файл.txt",
          workspacePath: "uploads/мой файл.txt",
          agentPath: "/runtime/workspace/uploads/мой файл.txt",
          textPart: { type: "text", text: "СЕКРЕТНОЕ СОДЕРЖИМОЕ" } as never,
        }),
      ],
      "прочитай",
    );
    expect(parts[0]).toMatchObject({
      type: "attachment",
      name: "мой файл.txt",
      path: "uploads/мой файл.txt",
      kind: "text",
    });
    expect(JSON.stringify(parts)).not.toContain("СЕКРЕТНОЕ СОДЕРЖИМОЕ");
  });

  it("zip хранит заметку в metadata typed-part", () => {
    const parts = buildPromptParts(
      [
        att({
          name: "b.zip",
          kind: "zip",
          mime: "application/zip",
          workspacePath: "uploads/b.zip",
          entryCount: 3,
        }),
      ],
      "t",
    );
    expect(parts[0]).toMatchObject({
      type: "attachment",
      path: "uploads/b.zip",
      note: expect.stringContaining("3 файлов"),
    });
  });

  it("без workspacePath незагруженный файл не попадает в prompt (I-20)", () => {
    const parts = buildPromptParts(
      [att({ kind: "binary", dataUrl: "data:x" })],
      "запрос",
    );
    expect(parts).toEqual([{ type: "text", text: "запрос" }]);
  });

  it("в mixed-наборе передаются только уже загруженные вложения", () => {
    const parts = buildPromptParts(
      [
        att({
          kind: "pdf",
          name: "готов.pdf",
          workspacePath: "uploads/готов.pdf",
        }),
        att({ kind: "pdf", name: "не-загрузился.pdf" }),
      ],
      "запрос",
    );
    expect(parts.filter((p) => p.type === "attachment")).toHaveLength(1);
    expect(parts[0]).toMatchObject({ name: "готов.pdf" });
  });
});

describe("assistantFinishState", () => {
  const asst = (over: Partial<Message>): Message =>
    ({ id: "msg_a", role: "assistant", parts: [], ...over }) as Message;

  it("нет assistant-сообщений — не завершено", () => {
    const r = assistantFinishState([
      { id: "msg_u", role: "user", parts: [] } as unknown as Message,
    ]);
    expect(r.isDone).toBe(false);
    expect(r.sig).toBe("|0|0||");
  });

  it("finish=stop и finish=error — завершено", () => {
    const stop = asst({ info: { finish: "stop" } as Message["info"] });
    const error = asst({ info: { finish: "error" } as Message["info"] });
    expect(assistantFinishState([stop]).isDone).toBe(true);
    expect(assistantFinishState([error]).isDone).toBe(true);
  });

  it("time.completed — завершено, completedAt отдаётся наружу", () => {
    const r = assistantFinishState([
      asst({
        info: { time: { created: 1, completed: 42 } } as Message["info"],
      }),
    ]);
    expect(r.isDone).toBe(true);
    expect(r.completedAt).toBe(42);
  });

  it("стриминг без finish/completed — не завершено", () => {
    expect(assistantFinishState([asst({})]).isDone).toBe(false);
  });

  it("смотрит на ПОСЛЕДНЕГО assistant; сигнатура отражает его состояние", () => {
    const done = asst({
      id: "msg_1",
      info: { finish: "stop" } as Message["info"],
    });
    const streaming = asst({
      id: "msg_2",
      parts: [{ id: "p1", type: "text", text: "..." }] as Message["parts"],
    });
    const r = assistantFinishState([done, streaming]);
    expect(r.isDone).toBe(false);
    expect(r.sig).toBe("msg_2|0|1||");
  });

  // Регрессия: из-за этих двух случаев `busy` снимался посреди хода, очередь
  // считала сессию свободной и отправляла следующее сообщение в работающий
  // ход — движок прерывал текущий ответ и начинал заново.
  it("остановка ради вызова инструмента — это шаг, а не финал", () => {
    const step = asst({
      info: {
        finish: "tool-calls",
        time: { created: 1, completed: 42 },
      } as Message["info"],
    });
    expect(assistantFinishState([step]).isDone).toBe(false);
  });

  it("работающий инструмент перевешивает финальный маркер", () => {
    const step = asst({
      info: {
        finish: "stop",
        time: { created: 1, completed: 42 },
      } as Message["info"],
      parts: [
        { id: "p1", type: "tool", tool: "bash", state: { status: "running" } },
      ] as unknown as Message["parts"],
    });
    const r = assistantFinishState([step]);
    expect(r.isDone).toBe(false);
    // Статус инструмента входит в сигнатуру: без него растущий вывод команды
    // не сдвигал бы её и тишина считалась бы подтверждённой.
    expect(r.sig).toContain("running");
  });
});
