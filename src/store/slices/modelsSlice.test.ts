import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { providerChannelsApi } from "../../api/providerChannels";
import { AUTO_MODEL } from "../../lib/autopilotModel";
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
  it("shows catalog models only for providers the user configured and defaults to Autopilot", async () => {
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
    expect(store.models[0]?.providerName).toBe("My Claude");
    expect(store.selectedModel).toEqual(AUTO_MODEL);
  });

  it("keeps an explicit model selection while it remains available", async () => {
    vi.spyOn(api, "listProviderCatalog").mockResolvedValue({
      models: [
        { providerID: "openai", providerName: "OpenAI", modelID: "chosen", modelName: "Chosen", free: false },
        { providerID: "openai", providerName: "OpenAI", modelID: "other", modelName: "Other", free: false },
      ],
    });
    mockChannels(["openai"]);
    const store = makeStore({ selectedModel: { providerID: "openai", modelID: "chosen" } });
    await store.loadModels();
    expect(store.selectedModel).toEqual({ providerID: "openai", modelID: "chosen" });
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

  it("сбой каталога не стирает уже загруженные модели и выбор пользователя", async () => {
    vi.spyOn(api, "listProviderCatalog").mockRejectedValue(new Error("offline"));
    mockChannels(["zai"]);
    const kept = { providerID: "zai", modelID: "glm-5.3" };
    const store = makeStore({
      models: [
        { providerID: "zai", providerName: "Z.AI", modelID: "glm-5.3", modelName: "GLM-5.3", free: false },
      ],
      modelsLoaded: true,
      selectedModel: kept,
    });
    await store.loadModels(true);
    // Раньше один неудачный опрос (мобильная сеть, 45-секундный бюджет)
    // обнулял селектор и выбранную модель — следующий ход уходил в Автопилот.
    expect(store.models).toHaveLength(1);
    expect(store.selectedModel).toEqual(kept);
    expect(store.modelsLoaded).toBe(true);
    expect(store.modelsError).toBe(true);
  });

  it("сохраняет выбор, если провайдер выбранной модели не отдал свой список", async () => {
    vi.spyOn(api, "listProviderCatalog").mockResolvedValue({
      models: [
        { providerID: "anthropic", providerName: "Anthropic", modelID: "claude-sonnet-4-6", modelName: "Claude", free: false },
      ],
    });
    mockChannels(["anthropic", "zai"]);
    const chosen = { providerID: "zai", modelID: "glm-5.3" };
    const store = makeStore({ selectedModel: chosen });
    await store.loadModels();
    expect(store.selectedModel).toEqual(chosen);
    expect(store.modelsError).toBe(false);
  });

  it("не подменяет выбор, когда провайдер жив, а модель удалили из каталога", async () => {
    vi.spyOn(api, "listProviderCatalog").mockResolvedValue({
      models: [
        { providerID: "zai", providerName: "Z.AI", modelID: "glm-5.4", modelName: "GLM-5.4", free: false },
      ],
    });
    mockChannels(["zai"]);
    const chosen = { providerID: "zai", modelID: "glm-5.3" };
    const store = makeStore({ selectedModel: chosen });
    await store.loadModels();
    // Молчаливый сброс на Автопилот и был одной из причин расхождения:
    // сверху стояла одна модель, а отвечала другая. Выбор сохраняем,
    // а о его отсутствии в каталоге честно сообщаем флагом: причину
    // отказа скажет сервер текстом в чате.
    expect(store.selectedModel).toEqual(chosen);
    expect(store.selectedModelMissing).toBe(true);
  });

  it("ставит Автопилот только когда выбора ещё не было", async () => {
    vi.spyOn(api, "listProviderCatalog").mockResolvedValue({
      models: [
        { providerID: "zai", providerName: "Z.AI", modelID: "glm-5.4", modelName: "GLM-5.4", free: false },
      ],
    });
    mockChannels(["zai"]);
    const store = makeStore({ selectedModel: null });
    await store.loadModels();
    expect(store.selectedModel).toEqual(AUTO_MODEL);
    expect(store.selectedModelMissing).toBe(false);
  });
});
