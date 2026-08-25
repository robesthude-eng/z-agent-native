import { describe, expect, test } from "vitest";
import { createScenarioHarness, mergeMessages } from "./messageMerge";
import type { Message, Part } from "./types";

// Фикстуры аннотируем как Message[]: без контекстного типа литерал
// `type: "text"` расширяется до string и перестаёт подходить под union Part.

// Part — открытый union (последний вариант принимает произвольные поля),
// поэтому .text и .state читаются через то же сужение, что и в messageMerge.ts.
function textOf(part: Part | undefined): string | undefined {
  const text = (part as { text?: unknown } | undefined)?.text;
  return typeof text === "string" ? text : undefined;
}

function toolStatusOf(part: Part | undefined): string | undefined {
  const state = (part as { state?: { status?: string } | string } | undefined)
    ?.state;
  return typeof state === "string" ? state : state?.status;
}

describe("mergeMessages deterministic", () => {
  test("keeps longer local streaming text when server not final", () => {
    const server: Message[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [{ id: "p1", type: "text", text: "first" }],
        info: {},
      },
    ];
    const local: Message[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [{ id: "p1", type: "text", text: "first second" }],
      },
    ];
    const merged = mergeMessages(server, local);
    expect(textOf(merged[0]?.parts[0])).toBe("first second");
  });

  test("keeps longer local streaming reasoning when server not final", () => {
    const server: Message[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [{ id: "p1", type: "reasoning", text: "think" }],
        info: {},
      },
    ];
    const local: Message[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [{ id: "p1", type: "reasoning", text: "think more" }],
      },
    ];
    const merged = mergeMessages(server, local);
    expect(textOf(merged[0]?.parts[0])).toBe("think more");
  });

  test("does not downgrade local completed tool part to stale running snapshot", () => {
    const server: Message[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [
          {
            id: "p1",
            type: "tool",
            tool: "bash",
            state: { status: "running" },
          },
        ],
        info: {},
      },
    ];
    const local: Message[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [
          {
            id: "p1",
            type: "tool",
            tool: "bash",
            state: { status: "completed", output: "done" },
          },
        ],
      },
    ];
    const merged = mergeMessages(server, local);
    expect(toolStatusOf(merged[0]?.parts[0])).toBe("completed");
  });

  test("server tool state wins when message is final", () => {
    const server: Message[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [
          {
            id: "p1",
            type: "tool",
            tool: "bash",
            state: { status: "error" },
          },
        ],
        info: { finish: "stop", time: { completed: Date.now() } },
      },
    ];
    const local: Message[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [
          {
            id: "p1",
            type: "tool",
            tool: "bash",
            state: { status: "completed" },
          },
        ],
      },
    ];
    const merged = mergeMessages(server, local);
    expect(toolStatusOf(merged[0]?.parts[0])).toBe("error");
  });

  test("server wins when final", () => {
    const server: Message[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [{ id: "p1", type: "text", text: "first" }],
        info: { finish: "stop", time: { completed: Date.now() } },
      },
    ];
    const local: Message[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [{ id: "p1", type: "text", text: "first second" }],
      },
    ];
    const merged = mergeMessages(server, local);
    expect(textOf(merged[0]?.parts[0])).toBe("first");
  });

  test("does not append a local text part whose wording already exists on the server", () => {
    const paragraph =
      "Проверю корректность логики — запущу тесты на движке Node.js.";
    const server: Message[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [{ id: "p_server", type: "text", text: paragraph }],
        info: {},
      },
    ];
    const local: Message[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [
          { id: "p_server", type: "text", text: paragraph },
          { id: "p_local", type: "text", text: paragraph },
        ],
      },
    ];
    const merged = mergeMessages(server, local);
    expect(merged[0]?.parts).toHaveLength(1);
    expect(merged[0]?.parts[0]?.id).toBe("p_server");
  });

  test("preserves local attachment when server has none", () => {
    const server: Message[] = [
      {
        id: "msg_1",
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      },
    ];
    const local: Message[] = [
      {
        id: "msg_1",
        role: "user",
        parts: [
          { type: "attachment", name: "a.txt" },
          { type: "text", text: "hi" },
        ],
      },
    ];
    const merged = mergeMessages(server, local);
    expect(merged[0]?.parts.some((p) => p.type === "attachment")).toBe(true);
  });

  test("scenario harness with delta", () => {
    const harness = createScenarioHarness(
      [
        {
          id: "msg_1",
          role: "assistant",
          parts: [{ id: "p1", type: "text", text: "first" }],
        },
      ],
      [
        {
          id: "msg_1",
          role: "assistant",
          parts: [{ id: "p1", type: "text", text: "first" }],
        },
      ],
    );
    harness.applyLocalDelta("ses", "msg_1", "p1", " second");
    expect(textOf(harness.getLocal()[0]?.parts[0])).toBe("first second");
    const merged = harness.getMerged();
    expect(textOf(merged[0]?.parts[0])).toBe("first second");
  });

  test("out-of-order delta creates missing part", () => {
    const harness = createScenarioHarness(
      [
        {
          id: "msg_1",
          role: "assistant",
          parts: [{ id: "p1", type: "text", text: "first" }],
        },
      ],
      [
        {
          id: "msg_1",
          role: "assistant",
          parts: [{ id: "p1", type: "text", text: "first" }],
        },
      ],
    );
    // Simulate server sends delta for part that doesn't exist locally yet
    const serverWithNewPart: Message[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [
          { id: "p1", type: "text", text: "first" },
          { id: "p_late", type: "text", text: "arrived first" },
        ],
      },
    ];
    const merged = harness.applyServerUpdate(serverWithNewPart);
    expect(merged[0]?.parts).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "p_late" })]),
    );
  });
});
