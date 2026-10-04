import { describe, expect, it, vi } from "vitest";
import {
  setWebSearchPreference,
  transferChatTools,
  webSearchPreference,
} from "./chatTools";
describe("per-chat tool restrictions", () => {
  it("keeps existing search behavior by default", () =>
    expect(webSearchPreference("fresh-owner", null)).toBe(true));
  it("isolates users and chats", () => {
    setWebSearchPreference("rob", "chat-a", false);
    expect(webSearchPreference("rob", "chat-a")).toBe(false);
    expect(webSearchPreference("other", "chat-a")).toBe(true);
    expect(webSearchPreference("rob", "chat-b")).toBe(true);
  });
  it("transfers draft restrictions to a materialized session", () => {
    setWebSearchPreference("draft-owner", null, false);
    transferChatTools("draft-owner", null, "temp");
    transferChatTools("draft-owner", "temp", "real");
    expect(webSearchPreference("draft-owner", "real")).toBe(false);
  });
  it("keeps restrictions even if browser storage fails", () => {
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("denied");
      });
    try {
      setWebSearchPreference("private-owner", "a", false);
      expect(webSearchPreference("private-owner", "a")).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});
