import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { State } from "../types";
import { createModelsSlice } from "./modelsSlice";

type Store = State & ReturnType<typeof createModelsSlice>;

function makeStore(initial: Partial<Store> = {}) {
  const store = { authed: {}, prefsUpdatedAt: {}, ...initial } as unknown as Store;
  const set = (update: unknown) => Object.assign(store, typeof update === "function" ? update(store) : update);
  Object.assign(store, createModelsSlice(set as never, (() => store) as never, {} as never), initial);
  return store;
}

afterEach(() => vi.restoreAllMocks());

describe("native model catalog", () => {
  it("uses exactly the runtime catalog as the selectable source", async () => {
    const catalog = vi.spyOn(api, "listProviderCatalog").mockResolvedValue({
      default: { anthropic: "claude-sonnet-4-6" },
      models: [
        { providerID: "anthropic", providerName: "Anthropic", modelID: "claude-sonnet-4-6", modelName: "Claude Sonnet 4.6", free: false },
        { providerID: "anymodel", providerName: "AnyModel", modelID: "am/glm-5.2", modelName: "GLM-5.2", free: true },
      ],
    });
    const store = makeStore();
    await store.loadModels();
    expect(catalog).toHaveBeenCalledTimes(1);
    expect(store.models.map((m) => `${m.providerID}/${m.modelID}`)).toEqual([
      "anthropic/claude-sonnet-4-6",
      "anymodel/am/glm-5.2",
    ]);
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
    const store = makeStore();
    await store.loadModels();
    expect(store.models[0]).toMatchObject({ sourceProviderID: "openai", endpoint: "https://llm.example/v1", source: "manual" });
  });

  it("filters owner-hidden models supplied by the runtime", async () => {
    vi.spyOn(api, "listProviderCatalog").mockResolvedValue({
      hidden: { openai: ["hidden-model"] },
      models: [
        { providerID: "openai", modelID: "hidden-model", modelName: "Hidden", free: false },
        { providerID: "openai", modelID: "visible-model", modelName: "Visible", free: false },
      ],
    });
    const store = makeStore();
    await store.loadModels();
    expect(store.models.map((m) => m.modelID)).toEqual(["visible-model"]);
  });

  it("fails closed when runtime/catalog is unavailable", async () => {
    vi.spyOn(api, "listProviderCatalog").mockRejectedValue(new Error("offline"));
    const store = makeStore({ selectedModel: { providerID: "openai", modelID: "gone" } });
    await store.loadModels();
    expect(store.models).toEqual([]);
    expect(store.modelsLoaded).toBe(true);
    expect(store.selectedModel).toBeNull();
  });
});
