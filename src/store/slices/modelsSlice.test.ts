import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { providerChannelsApi } from "../../api/providerChannels";
import type { State } from "../types";
import { createModelsSlice } from "./modelsSlice";

type Store = State & ReturnType<typeof createModelsSlice>;

function makeStore(initial: Partial<Store> = {}) {
  const store = { authed: {}, prefsUpdatedAt: {}, ...initial } as unknown as Store;
  const set = (update: unknown) => Object.assign(store, typeof update === "function" ? update(store) : update);
  Object.assign(store, createModelsSlice(set as never, (() => store) as never, {} as never), initial);
  return store;
}

function mockChannels(ids: string[]) {
  return vi.spyOn(providerChannelsApi, "list").mockResolvedValue({
    providers: ids.map((id) => ({
      id,
      name: id === "anthropic" ? "My Claude" : id === "anymodel" ? "My AnyModel" : "My Provider",
      protocol: "openai" as const,
      baseURL: "https://models.example/v1",
      enabled: true,
      custom: true,
      connected: true,
      overridden: false,
    })),
  });
}

afterEach(() => vi.restoreAllMocks());

describe("native model catalog", () => {
  it("shows catalog models only for providers the user configured", async () => {
    const catalog = vi.spyOn(api, "listProviderCatalog").mockResolvedValue({
      default: { anthropic: "claude-sonnet-4-6" },
      models: [
        { providerID: "anthropic", providerName: "Anthropic", modelID: "claude-sonnet-4-6", modelName: "Claude Sonnet 4.6", free: false },
        { providerID: "anymodel", providerName: "AnyModel", modelID: "am/glm-5.2", modelName: "GLM-5.2", free: true },
        { providerID: "openai", providerName: "OpenAI", modelID: "gpt-hidden-template", modelName: "GPT", free: false },
      ],
    });
    const channels = mockChannels(["anthropic", "anymodel"]);
    const store = makeStore();
    await store.loadModels();
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(channels).toHaveBeenCalledTimes(1);
    expect(store.models.map((m) => `${m.providerID}/${m.modelID}`)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "anymodel/am/glm-5.2",
    ]);
    expect(store.models[0].providerName).toBe("My Claude");
    expect(store.selectedModel).toEqual({ providerID: "anthropic", modelID: "claude-sonnet-4-6" });
  });

  it("preserves source provider metadata for a custom endpoint", async () => {
    vi.spyOn(api, "listProviderCatalog").mockResolvedValue({
      models: [{
        providerID: "custom:openai:abc",
        sourceProviderID: "openai",
        providerName: "OpenAI",
        modelID: "my-model",
        modelName: "My model",
        source: "manual",
        endpoint: "https://llm.example/v1",
        status: "live",
        free: false,
      }],
    });
    mockChannels(["openai"]);
    const store = makeStore();
    await store.loadModels();
    expect(store.models[0]).toMatchObject({ sourceProviderID: "openai", endpoint: "https://llm.example/v1", source: "manual" });
  });

  it("filters owner-hidden models supplied by the runtime", async () => {
    vi.spyOn(api, "listProviderCatalog").mockResolvedValue({
      hidden: { openai: ["hidden-model"] },
      models: [
        { providerID: "openai", providerName: "OpenAI", modelID: "hidden-model", modelName: "Hidden", free: false },
        { providerID: "openai", providerName: "OpenAI", modelID: "visible-model", modelName: "Visible", free: false },
      ],
    });
    mockChannels(["openai"]);
    const store = makeStore();
    await store.loadModels();
    expect(store.models.map((m) => m.modelID)).toEqual(["visible-model"]);
  });

  it("fails closed when runtime/catalog is unavailable", async () => {
    vi.spyOn(api, "listProviderCatalog").mockRejectedValue(new Error("offline"));
    mockChannels(["openai"]);
    const store = makeStore({ selectedModel: { providerID: "openai", modelID: "gone" } });
    await store.loadModels();
    expect(store.models).toEqual([]);
    expect(store.modelsLoaded).toBe(true);
    expect(store.selectedModel).toBeNull();
  });
});
