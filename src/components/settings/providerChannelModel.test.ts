import { describe, expect, it } from "vitest";
import type { ProviderChannel } from "@/api/providerChannels";
import {
  draftFromChannel,
  filterProviderModels,
  providerColor,
} from "./providerChannelModel";

describe("provider channel presentation model", () => {
  it("assigns a stable palette color", () => {
    expect(providerColor("openai")).toBe(providerColor("openai"));
    expect(providerColor("openai")).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("copies editable channel fields without leaking connection state", () => {
    const channel: ProviderChannel = {
      id: "demo",
      name: "Demo",
      protocol: "openai",
      baseURL: "https://api.example.com/v1",
      enabled: true,
      custom: true,
      connected: true,
    };

    expect(draftFromChannel(channel)).toEqual({
      id: "demo",
      name: "Demo",
      protocol: "openai",
      baseURL: "https://api.example.com/v1",
      enabled: true,
      custom: true,
    });
  });

  it("filters model ids and display names case-insensitively", () => {
    const models = [
      { id: "gpt-5", name: "GPT Five" },
      { id: "claude-sonnet", name: "Claude Sonnet" },
    ];
    expect(filterProviderModels(models, "SONNET")).toEqual([models[1]]);
    expect(filterProviderModels(models, "gpt-5")).toEqual([models[0]]);
    expect(filterProviderModels(models, "  ")).toBe(models);
  });
});
