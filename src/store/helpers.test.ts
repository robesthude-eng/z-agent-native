// biome-ignore-all lint/suspicious/noExplicitAny: тесты намеренно подсовывают
// невалидные формы Part/Message, чтобы проверить нормализацию
import { describe, expect, it, test } from "vitest";
import type { Message, Part } from "../api/types";
import {
  cleanSysText,
  normalizeMessage,
  normalizeMessages,
  patchPart,
  patchPartDelta,
  upsertMessage,
} from "./helpers";

describe("helpers.ts — Token & Message Processing Architecture", () => {
  describe("cleanSysText()", () => {
    it("keeps user text untouched because runtime policy is server-owned", () => {
      const input = "Hello world!\n\n[SYSTEM: literal user text]";
      expect(cleanSysText(input)).toBe(input);
    });

    it("normalizes empty non-string values without injecting policy text", () => {
      expect(cleanSysText(null as any)).toBe("");
      expect(cleanSysText(undefined as any)).toBe("");
      expect(cleanSysText(123 as any)).toBe(123 as any);
    });
  });

  describe("normalizeMessage()", () => {
    it("4. extracts id and role from info object if missing at top level", () => {
      const raw: any = {
        info: { id: "msg_100", role: "assistant" },
        parts: [{ type: "text", text: "Hello!" }],
      };
      const res = normalizeMessage(raw);
      expect(res.id).toBe("msg_100");
      expect(res.role).toBe("assistant");
    });

    it("5. preserves literal user text", () => {
      const raw: Message = {
        id: "msg_user_1",
        role: "user",
        parts: [
          { type: "text", text: "Help me check bugs\n\n[SYSTEM: literal]" },
        ],
      };
      const res = normalizeMessage(raw);
      expect((res.parts[0] as any).text).toBe(
        "Help me check bugs\n\n[SYSTEM: literal]",
      );
    });

    it("6. leaves assistant messages untouched by system text cleaning", () => {
      const raw: Message = {
        id: "msg_ai_1",
        role: "assistant",
        parts: [
          { type: "text", text: "Here is the code:\n\n[SYSTEM: something]" },
        ],
      };
      const res = normalizeMessage(raw);
      expect((res.parts[0] as any).text).toContain("[SYSTEM: something]");
    });
  });

  describe("normalizeMessages()", () => {
    it("7. maps an array of raw messages through normalizeMessage", () => {
      const input: any[] = [
        {
          info: { id: "m1", role: "user" },
          parts: [
            { type: "text", text: "Hi\n\n[SYSTEM: Режим саморазвития тест]" },
          ],
        },
        {
          info: { id: "m2", role: "assistant" },
          parts: [{ type: "text", text: "Hello there" }],
        },
      ];
      const res = normalizeMessages(input);
      expect(res).toHaveLength(2);
      expect(res[0]?.id).toBe("m1");
      expect((res[0]?.parts[0] as any)?.text).toBe(
        "Hi\n\n[SYSTEM: Режим саморазвития тест]",
      );
      expect(res[1]?.id).toBe("m2");
    });
  });

  describe("upsertMessage()", () => {
    it("8. appends a brand new message if its ID is not in the array", () => {
      const existing: Message[] = [{ id: "m1", role: "user", parts: [] }];
      const newMsg: Message = {
        id: "m2",
        role: "assistant",
        parts: [{ type: "text", text: "Ok" }],
      };
      const res = upsertMessage(existing, newMsg);
      expect(res).toHaveLength(2);
      expect(res[1]?.id).toBe("m2");
    });

    it("9. replaces optimistic local_... user message with authoritative server message ID without duplication", () => {
      const existing: Message[] = [
        {
          id: "local_1700000",
          role: "user",
          parts: [{ type: "text", text: "Fix this bug" }],
        },
      ];
      const serverMsg: Message = {
        id: "msg_server_888",
        role: "user",
        parts: [{ type: "text", text: "Fix this bug" }],
      };
      const res = upsertMessage(existing, serverMsg);
      expect(res).toHaveLength(1);
      expect(res[0]?.id).toBe("msg_server_888");
    });

    it("10. updates existing message while preserving accumulated text/tool parts when server sends info-only update", () => {
      const existing: Message[] = [
        {
          id: "msg_ai_5",
          role: "assistant",
          parts: [{ type: "text", text: "Accumulated streaming text..." }],
        },
      ];
      const infoUpdate: Message = {
        id: "msg_ai_5",
        role: "assistant",
        parts: [],
      };
      const res = upsertMessage(existing, infoUpdate);
      expect(res).toHaveLength(1);
      expect(res[0]?.parts).toHaveLength(1);
      expect((res[0]?.parts[0] as any)?.text).toBe(
        "Accumulated streaming text...",
      );
    });
  });

  describe("patchPart()", () => {
    it("11. creates message shell with incoming part if target message does not exist yet", () => {
      const existing: Message[] = [];
      const part: Part = { type: "text", text: "First chunk" };
      const res = patchPart(existing, "msg_new_1", part);
      expect(res).toHaveLength(1);
      expect(res[0]?.id).toBe("msg_new_1");
      expect(res[0]?.parts[0]).toEqual(part);
    });

    it("12. updates existing un-IDd text part in place instead of duplicating", () => {
      const existing: Message[] = [
        {
          id: "msg_1",
          role: "assistant",
          parts: [{ type: "text", text: "Initial" }],
        },
      ];
      const newPart: Part = { type: "text", text: "Updated text" };
      const res = patchPart(existing, "msg_1", newPart);
      expect(res).toHaveLength(1);
      expect(res[0]?.parts).toHaveLength(1);
      expect((res[0]?.parts[0] as any)?.text).toBe("Updated text");
    });

    it("13. updates existing IDd part by matching part ID", () => {
      const existing: Message[] = [
        {
          id: "msg_1",
          role: "assistant",
          parts: [{ id: "part_a", type: "tool", tool: "bash" } as any],
        },
      ];
      const updatedPart: any = {
        id: "part_a",
        type: "tool",
        tool: "bash",
        status: "completed",
      };
      const res = patchPart(existing, "msg_1", updatedPart);
      expect(res[0]?.parts).toHaveLength(1);
      expect((res[0]?.parts[0] as any)?.status).toBe("completed");
    });
  });

  describe("patchPartDelta() — Real-time Character Streaming", () => {
    it("14. appends delta string character by character during live SSE streaming", () => {
      const existing: Message[] = [
        {
          id: "msg_1",
          role: "assistant",
          parts: [{ id: "p_1", type: "text", text: "Hello" } as any],
        },
      ];
      const res = patchPartDelta(existing, "msg_1", "p_1", "text", ", world!");
      expect((res[0]?.parts[0] as any)?.text).toBe("Hello, world!");
    });

    it("15. handles non-string deltas and creates stub part if part ID does not exist yet", () => {
      const existing: Message[] = [
        { id: "msg_1", role: "assistant", parts: [] },
      ];
      const res = patchPartDelta(
        existing,
        "msg_1",
        "p_99",
        "status",
        "running",
      );
      expect(res[0]?.parts).toHaveLength(1);
      expect((res[0]?.parts[0] as any)?.id).toBe("p_99");
      expect((res[0]?.parts[0] as any)?.status).toBe("running");
    });
  });
});

// P3: дополнительные тесты стриминговых патчей — patchPart / patchPartDelta.
describe("patchPart() / patchPartDelta() — P3 edge cases", () => {
  const shell = (parts: Part[] = []): Message => ({
    id: "m1",
    role: "assistant",
    parts,
  });

  describe("patchPartDelta()", () => {
    it("creates a hidden 'stub' part when a non-text delta arrives before the message exists", () => {
      const res = patchPartDelta([], "m1", "p1", "output", "chunk");
      expect(res).toHaveLength(1);
      const part = res[0]?.parts[0] as any;
      expect(part.id).toBe("p1");
      expect(part.type).toBe("stub");
      expect(part.output).toBe("chunk");
    });

    it("creates a real 'text' part when a text delta arrives before the message exists", () => {
      const res = patchPartDelta([], "m1", "p1", "text", "Hel");
      const part = res[0]?.parts[0] as any;
      expect(part.type).toBe("text");
      expect(part.text).toBe("Hel");
    });

    it("creates a 'stub' part inside an existing message when partID is unknown and field is not text", () => {
      const res = patchPartDelta([shell()], "m1", "p1", "reasoning", "Thin");
      const part = res[0]?.parts[0] as any;
      expect(part.type).toBe("stub");
      expect(part.reasoning).toBe("Thin");
    });

    it("appends string deltas to the existing field value", () => {
      let msgs = patchPartDelta([], "m1", "p1", "text", "Hello, ");
      msgs = patchPartDelta(msgs, "m1", "p1", "text", "world");
      msgs = patchPartDelta(msgs, "m1", "p1", "text", "!");
      expect((msgs[0]?.parts[0] as any)?.text).toBe("Hello, world!");
    });

    it("does not append a long SSE paragraph that is already the suffix", () => {
      const paragraph = "Проверю корректность логики — запущу тесты.";
      const start = [
        shell([{ id: "p1", type: "text", text: paragraph } as any]),
      ];
      const res = patchPartDelta(start, "m1", "p1", "text", paragraph);
      expect((res[0]?.parts[0] as any)?.text).toBe(paragraph);
    });

    it("does not append a long replayed first chunk already at the start", () => {
      const full =
        "Проверю корректность логики — запущу тесты на движке Node.js.";
      const first = full.slice(0, 24);
      const start = [shell([{ id: "p1", type: "text", text: full } as any])];
      const res = patchPartDelta(start, "m1", "p1", "text", first);
      expect((res[0]?.parts[0] as any)?.text).toBe(full);
    });

    it("still appends a short token even if it matches the last character", () => {
      const start = [shell([{ id: "p1", type: "text", text: "с" } as any])];
      const res = patchPartDelta(start, "m1", "p1", "text", "с");
      expect((res[0]?.parts[0] as any)?.text).toBe("сс");
    });

    it("replaces the field for non-string deltas (e.g. tool state object)", () => {
      const start = [shell([{ id: "p1", type: "tool", tool: "bash" } as any])];
      const state = { status: "running" };
      const res = patchPartDelta(start, "m1", "p1", "state", state);
      expect((res[0]?.parts[0] as any)?.state).toEqual(state);
    });

    it("returns the input array untouched when identifiers or delta are missing", () => {
      const msgs = [shell()];
      expect(patchPartDelta(msgs, "", "p1", "text", "x")).toBe(msgs);
      expect(patchPartDelta(msgs, "m1", "", "text", "x")).toBe(msgs);
      expect(patchPartDelta(msgs, "m1", "p1", "", "x")).toBe(msgs);
      expect(patchPartDelta(msgs, "m1", "p1", "text", undefined)).toBe(msgs);
    });

    it("does not touch other messages", () => {
      const other: Message = {
        id: "m2",
        role: "assistant",
        parts: [{ id: "px", type: "text", text: "keep" } as any],
      };
      const res = patchPartDelta(
        [shell([{ id: "p1", type: "text", text: "a" } as any]), other],
        "m1",
        "p1",
        "text",
        "b",
      );
      expect((res[0]?.parts[0] as any)?.text).toBe("ab");
      expect(res[1]).toBe(other);
    });
  });

  describe("patchPart() ↔ patchPartDelta() integration", () => {
    it("upgrades a streamed 'stub' part to the real tool part keeping accumulated fields", () => {
      let msgs = patchPartDelta([], "m1", "p1", "output", "npm ins");
      msgs = patchPartDelta(msgs, "m1", "p1", "output", "tall done");
      msgs = patchPart(msgs, "m1", {
        id: "p1",
        type: "tool",
        tool: "bash",
      } as any);
      const part = msgs[0]?.parts[0] as any;
      expect(part.type).toBe("tool");
      expect(part.tool).toBe("bash");
      // накопленный стриминговый output не теряется при апгрейде
      expect(part.output).toBe("npm install done");
      expect(msgs[0]?.parts).toHaveLength(1);
    });

    it("merges an update into the part matched by id instead of appending a duplicate", () => {
      const start = [shell([{ id: "p1", type: "text", text: "draft" } as any])];
      const res = patchPart(start, "m1", {
        id: "p1",
        type: "text",
        text: "final",
      } as any);
      expect(res[0]?.parts).toHaveLength(1);
      expect((res[0]?.parts[0] as any)?.text).toBe("final");
    });

    it("normalizes object tool references to undefined (React error #31 guard)", () => {
      const res = patchPart([shell()], "m1", {
        id: "p1",
        type: "tool",
        tool: { messageID: "m1", callID: "c1" },
      } as any);
      expect((res[0]?.parts[0] as any)?.tool).toBeUndefined();
    });

    it("opaque tool reference does not erase an already known tool name", () => {
      const start = [
        shell([
          {
            id: "p1",
            type: "tool",
            tool: "bash",
            state: { status: "running" },
          } as any,
        ]),
      ];
      const res = patchPart(start, "m1", {
        id: "p1",
        type: "tool",
        tool: { messageID: "m1", callID: "c1" },
        state: { status: "completed" },
      } as any);
      expect((res[0]?.parts[0] as any)?.tool).toBe("bash");
      expect((res[0]?.parts[0] as any)?.state?.status).toBe("completed");
    });
  });
});

// Semantic sanity checks for patchPart (Release 1 task 8 guarantees)
describe("patchPart/patchPartDelta Release 1 semantic guarantees", () => {
  const localUser: Message = {
    id: "local_abc",
    role: "user",
    parts: [{ type: "text", text: "привет, сделай таск" } as Part],
  };

  test("assistant tokens for unknown ID never steal the local user bubble", () => {
    const result = patchPart([localUser], "msg_real_1", {
      type: "text",
      text: "Конечно! Начинаю...",
    } as Part);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      id: "local_abc",
      role: "user",
    });
    expect((result[0]?.parts[0] as { text: string } | undefined)?.text).toBe(
      "привет, сделай таск",
    );
    expect(result[1]).toMatchObject({
      id: "msg_real_1",
      role: "assistant",
    });
  });

  test("exact text match adopts the local message without duplication", () => {
    const result = patchPart([localUser], "msg_user_1", {
      type: "text",
      text: "привет, сделай таск",
    } as Part);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "msg_user_1",
      role: "user",
    });
  });

  test("unknown tool parts create assistant stub instead of touching user messages", () => {
    const result = patchPart([localUser], "msg_real_2", {
      id: "prt_1",
      type: "tool",
      tool: "bash",
    } as unknown as Part);

    expect(result).toHaveLength(2);
    expect(result[1]?.role).toBe("assistant");
    expect(result[0]?.id).toBe("local_abc");
  });

  test("applying identical part twice is idempotent (no duplicates)", () => {
    const toolPart = {
      id: "prt_2",
      type: "tool",
      tool: "bash",
    } as unknown as Part;
    const once = patchPart([], "msg_real_3", toolPart);
    const twice = patchPart(once, "msg_real_3", toolPart);

    expect(twice).toHaveLength(1);
    expect(twice[0]?.parts).toHaveLength(1);
  });

  test("early metadata delta creates assistant stub without touching user message", () => {
    const result = patchPartDelta(
      [localUser],
      "msg_real_4",
      "prt_3",
      "metadata",
      { x: 1 },
    );

    expect(result).toHaveLength(2);
    expect(result[1]?.role).toBe("assistant");
    expect(result[0]?.id).toBe("local_abc");
  });

  test("early text delta creates an assistant stub with a text part", () => {
    const result = patchPartDelta([], "msg_real_5", "prt_4", "text", "При");

    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe("assistant");
    expect(result[0]?.parts[0]?.type).toBe("text");
  });
});
