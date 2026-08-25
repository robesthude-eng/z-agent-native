import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  configure,
  pendingQuestionForSession,
  type PendingQuestion,
} from "./client";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

describe("Question API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    configure({ baseUrl: "/api" });
  });

  it("выбирает pending request своей сессии", () => {
    const list: PendingQuestion[] = [
      { id: "que_other", sessionID: "ses_b", questions: [] },
      { id: "que_own", sessionID: "ses_a", questions: [] },
    ];
    expect(pendingQuestionForSession(list, "ses_a")?.id).toBe("que_own");
  });

  it("GET идёт на /question с sessionId только как routing hint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        jsonResponse([{ id: "que_1", sessionID: "ses_a", questions: [] }]),
      );

    const result = await api.listPendingQuestions("ses_a");

    expect(result[0]?.id).toBe("que_1");
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "/api/question?sessionId=ses_a",
    );
  });

  it("reply отправляет answers в тот же que_* и не вызывает session abort", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(true));

    await api.replyQuestion("ses_a", "que_123", [["Вариант 1"], ["текст"]]);

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "/api/question/que_123/reply?sessionId=ses_a",
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      answers: [["Вариант 1"], ["текст"]],
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("/abort");
  });
});
