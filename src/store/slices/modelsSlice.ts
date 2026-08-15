import { api } from "../../api/client";
import { PROVIDERS } from "../../config/providers";
import { pushPref } from "../prefsSync";
import type { ModelEntry, ModelsSlice, Slice } from "../types";

/** The native runtime is the single source of truth for selectable models. */
export const createModelsSlice: Slice<ModelsSlice> = (set, get) => ({
  models: [],
  modelsLoaded: false,
  selectedModel: null,

  loadModels: async (force?: boolean) => {
    if (get().modelsLoaded && !force) return;
    const entries: ModelEntry[] = [];
    let defaults: Record<string, string> = {};

    try {
      const catalog = await api.listProviderCatalog();
      defaults = catalog.default ?? {};
      const hiddenByProvider = catalog.hidden ?? {};
      for (const model of catalog.models ?? []) {
        if (!model?.providerID || !model?.modelID) continue;
        const sourceProviderID = model.sourceProviderID || model.providerID;
        if (hiddenByProvider[sourceProviderID]?.includes(model.modelID)) continue;
        const provider = PROVIDERS.find((item) => item.id === sourceProviderID);
        entries.push({
          providerID: model.providerID,
          providerName: provider?.name || model.providerName || sourceProviderID,
          modelID: model.modelID,
          modelName: model.modelName || model.modelID,
          free: Boolean(model.free),
          sourceProviderID,
          source: model.source,
          endpoint: model.endpoint ?? null,
          status: model.status,
        });
      }
    } catch {
      // A disconnected runtime/provider yields an empty selector rather than a
      // hard-coded model that may not actually be callable.
    }

    let selected = get().selectedModel;
    const stillAvailable =
      selected &&
      entries.some(
        (entry) =>
          entry.providerID === selected?.providerID &&
          entry.modelID === selected?.modelID,
      );

    if (!stillAvailable) {
      const defaultEntry = entries.find(
        (entry) => defaults[entry.providerID] === entry.modelID,
      );
      const first = defaultEntry ?? entries[0];
      selected = first
        ? { providerID: first.providerID, modelID: first.modelID }
        : null;
    }

    set({ models: entries, modelsLoaded: true, selectedModel: selected });
  },

  setSelectedModel: (selectedModel) => {
    const updatedAt = Date.now();
    set((state) => ({
      selectedModel,
      prefsUpdatedAt: { ...state.prefsUpdatedAt, selectedModel: updatedAt },
    }));
    pushPref("selectedModel", selectedModel, updatedAt);
  },
});
