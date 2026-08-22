import { api } from "../../api/client";
import { providerChannelsApi } from "../../api/providerChannels";
import { AUTO_MODEL, isAutoModel } from "../../lib/autopilotModel";
import { pushPref } from "../prefsSync";
import type { ModelEntry, ModelsSlice, Slice } from "../types";

/** The native runtime is the single source of truth for selectable models. */
export const createModelsSlice: Slice<ModelsSlice> = (set, get) => ({
  models: [],
  modelsLoaded: false,
  modelsError: false,
  selectedModel: null,

  loadModels: async (force?: boolean) => {
    if (get().modelsLoaded && !force) return;
    const entries: ModelEntry[] = [];

    try {
      const [catalog, channelsResponse] = await Promise.all([
        api.listProviderCatalog(),
        providerChannelsApi.list(),
      ]);
      const hiddenByProvider = catalog.hidden ?? {};
      const configured = new Map(
        (channelsResponse.providers ?? []).map((provider) => [provider.id, provider]),
      );

      for (const model of catalog.models ?? []) {
        if (!model?.providerID || !model?.modelID) continue;
        const sourceProviderID = model.sourceProviderID || model.providerID;
        const provider = configured.get(sourceProviderID);
        if (!provider?.enabled) continue;
        if (catalog.providers?.[sourceProviderID]?.status === "disabled") continue;
        if (hiddenByProvider[sourceProviderID]?.includes(model.modelID)) continue;
        entries.push({
          providerID: model.providerID,
          providerName: provider.name || model.providerName || sourceProviderID,
          modelID: model.modelID,
          modelName: model.modelName || model.modelID,
          free: Boolean(model.free),
          sourceProviderID,
          ...(model.source ? { source: model.source } : {}),
          endpoint: model.endpoint ?? null,
          ...(model.status ? { status: model.status } : {}),
        });
      }
    } catch {
      // Каталог не «пустой», он неизвестен: рантайм не ответил (мобильная
      // сеть, VPN, 45-секундный бюджет запроса к каталогу). Раньше ошибка
      // проглатывалась целиком и ниже записывался пустой список: селектор
      // писал «Подключить модель», как будто провайдеры не настроены, а выбранная
      // модель молча сбрасывалась на Автопилот — следующий вопрос уходил в
      // другую модель. Сохраняем прошлый список и выбор, пометив сбой.
      set({ modelsLoaded: true, modelsError: true });
      return;
    }

    let selected = get().selectedModel;
    const stillAvailable =
      selected &&
      (isAutoModel(selected)
        ? entries.length > 0
        : entries.some(
            (entry) =>
              entry.providerID === selected?.providerID &&
              entry.modelID === selected?.modelID,
          ));

    // Провайдер выбранной модели мог не отдать свой список (его каталог
    // сбойнул или отдал cache-статус), и тогда модель исчезает из entries,
    // хотя реально доступна: сервер зовёт её по своей конфигурации, а не по
    // браузерному каталогу. Сбрасываем выбор на Автопилот только если
    // провайдер жив и модель действительно пропала из его списка.
    const providerAlive =
      !selected || isAutoModel(selected)
        ? true
        : entries.some((entry) => entry.providerID === selected?.providerID);

    if (!stillAvailable && providerAlive) {
      // New users and stale/removed explicit selections fall back to the
      // server-owned Autopilot. The runtime then applies configured defaults,
      // model health and provider fallback instead of the browser guessing.
      selected = entries.length > 0 ? { ...AUTO_MODEL } : null;
    }

    set({
      models: entries,
      modelsLoaded: true,
      modelsError: false,
      selectedModel: selected,
    });
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
