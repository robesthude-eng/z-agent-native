import { describe, expect, it } from "vitest";
import {
  dropDraft,
  isVersionConflict,
  stashDraft,
  takeDraft,
} from "./editorDrafts";

describe("editorDrafts", () => {
  const file = { path: "src/app.ts", content: "base", version: "sha256:1" };

  it("откладывает несохранённый черновик по сессии и пути и отдаёт его один раз", () => {
    stashDraft("ses_a", file, "edited");
    expect(takeDraft("ses_b", file.path)).toBeNull();
    expect(takeDraft("ses_a", file.path)).toEqual({
      draft: "edited",
      base: "base",
      version: "sha256:1",
    });
    expect(takeDraft("ses_a", file.path)).toBeNull();
  });

  it("не хранит ничего для чистого редактора и забывает черновик по dropDraft", () => {
    stashDraft("ses_a", file, "base");
    expect(takeDraft("ses_a", file.path)).toBeNull();
    stashDraft("ses_a", file, "edited");
    dropDraft("ses_a", file.path);
    expect(takeDraft("ses_a", file.path)).toBeNull();
  });

  it("распознаёт конфликт версии только по 409 с кодом сервера", () => {
    expect(
      isVersionConflict({
        status: 409,
        data: { code: "WORKSPACE_FILE_CONFLICT" },
      }),
    ).toBe(true);
    expect(isVersionConflict({ status: 409, data: null })).toBe(false);
    expect(isVersionConflict(new Error("409 Conflict"))).toBe(false);
  });
});
