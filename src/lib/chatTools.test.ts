import { describe, expect, it, vi } from "vitest";
import {
  bashFirstPreference,
  setBashFirstPreference,
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
  it("keeps bash-first off unless the user turns it on, per chat", () => {
    expect(bashFirstPreference("fresh-owner", null)).toBe(false);
    setBashFirstPreference("rob", "chat-bf", true);
    expect(bashFirstPreference("rob", "chat-bf")).toBe(true);
    expect(bashFirstPreference("rob", "chat-other")).toBe(false);
    expect(bashFirstPreference("other", "chat-bf")).toBe(false);
  });
  it("transfers the bash-first choice from a draft to the real session", () => {
    setBashFirstPreference("draft-bf", null, true);
    transferChatTools("draft-bf", null, "temp-bf");
    transferChatTools("draft-bf", "temp-bf", "real-bf");
    expect(bashFirstPreference("draft-bf", "real-bf")).toBe(true);
  });
});
