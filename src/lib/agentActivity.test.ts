import type { Message } from "@/api/types";
import { activityDetail, describeAgentActivity } from "./agentActivity";

function assistant(parts: unknown[]): Message[] {
  return [
    { id: "m1", role: "assistant", parts: parts as Message["parts"] },
  ] as Message[];
}

describe("describeAgentActivity", () => {
  it("показывает реальный инструмент и его цель, а не «анализирует проект»", () => {
    const activity = describeAgentActivity(
      assistant([
        {
          type: "tool",
          tool: "websearch",
          callID: "c1",
          state: { status: "running", input: { query: "погода Приозерск" } },
        },
      ]),
    );
    expect(activity.label).toBe("Ищет в интернете");
    expect(activity.detail).toBe("погода Приозерск");
    expect(activity.step).toBe(1);
    expect(activity.steps).toHaveLength(1);
    expect(activity.steps[0]?.state).toBe("running");
  });

  it("собирает след последних шагов с их статусами", () => {
    const activity = describeAgentActivity(
      assistant([
        {
          type: "tool",
          tool: "read",
          callID: "c1",
          state: { status: "completed", input: { path: "src/app/main.ts" } },
        },
        {
          type: "tool",
          tool: "websearch",
          callID: "c2",
          state: { status: "error", input: { query: "x" } },
        },
        {
          type: "tool",
          tool: "bash",
          callID: "c3",
          state: { status: "running", input: { command: "npm test" } },
        },
      ]),
    );
    expect(activity.step).toBe(3);
    expect(activity.steps.map((step) => step.state)).toEqual([
      "done",
      "error",
      "running",
    ]);
    expect(activity.label).toBe("Команда");
    expect(activity.detail).toBe("npm test");
  });

  it("различает размышление, письмо ответа и паузу после действия", () => {
    expect(
      describeAgentActivity(assistant([{ type: "reasoning", text: "…" }]))
        .label,
    ).toBe("Размышляет");
    expect(
      describeAgentActivity(assistant([{ type: "text", text: "Готово" }]))
        .label,
    ).toBe("Пишет ответ");
    expect(
      describeAgentActivity(
        assistant([
          {
            type: "tool",
            tool: "read",
            callID: "c1",
            state: { status: "completed", input: { path: "a.ts" } },
          },
        ]),
      ).label,
    ).toBe("Готовит следующий шаг");
    expect(describeAgentActivity([]).label).toBe("Начинает");
  });
});

describe("activityDetail", () => {
  it("берёт цель из аргументов инструмента", () => {
    expect(
      activityDetail("webfetch", {
        state: { input: { url: "https://example.com/a/b" } },
      }),
    ).toBe("example.com");
    expect(
      activityDetail("glob", { state: { input: { pattern: "**/*.ts" } } }),
    ).toBe("**/*.ts");
    expect(
      activityDetail("read", {
        state: { input: { path: "src/deep/nested/file.ts" } },
      }),
    ).toBe("nested/file.ts");
    expect(
      activityDetail("todowrite", { state: { input: { todos: [1, 2, 3] } } }),
    ).toBe("3 п.");
    expect(
      activityDetail("task", { state: { input: { agent: "security" } } }),
    ).toBe("security");
  });
});
