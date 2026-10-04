import { describe, expect, it } from "vitest";
import {
  applyAppSettings,
  DEFAULT_APP_SETTINGS,
  MAX_INSTRUCTIONS,
  normalizeAppSettings,
} from "./appSettings";

describe("normalizeAppSettings", () => {
  it("falls back to defaults for junk", () => {
    expect(normalizeAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(
      normalizeAppSettings({
        fontScale: "huge",
        sendKey: 1,
        notifyOnDone: "yes",
      }),
    ).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("keeps valid values and caps instructions", () => {
    const s = normalizeAppSettings({
      fontScale: "lg",
      chatWidth: "wide",
      sendKey: "mod-enter",
      reduceMotion: true,
      customInstructions: "a".repeat(MAX_INSTRUCTIONS + 50),
    });
    expect(s.fontScale).toBe("lg");
    expect(s.chatWidth).toBe("wide");
    expect(s.sendKey).toBe("mod-enter");
    expect(s.reduceMotion).toBe(true);
    expect(s.customInstructions).toHaveLength(MAX_INSTRUCTIONS);
  });
});

describe("applyAppSettings", () => {
  it("sets font size, chat width and motion flag on the root", () => {
    applyAppSettings({
      ...DEFAULT_APP_SETTINGS,
      fontScale: "xl",
      chatWidth: "narrow",
      reduceMotion: true,
    });
    const root = document.documentElement;
    expect(root.style.fontSize).toBe("19px");
    expect(root.style.getPropertyValue("--chat-max")).toBe("40rem");
    expect(root.dataset.reduceMotion).toBe("true");
    applyAppSettings(DEFAULT_APP_SETTINGS);
    expect(root.dataset.reduceMotion).toBeUndefined();
  });
});
