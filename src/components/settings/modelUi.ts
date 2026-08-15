import type {
  ManualModel,
  ProviderCatalogModel,
  ProviderCatalogStatus,
} from "@/api/types";

export type ManualUiState = "available" | "stale" | "hidden" | "unavailable";

export function findManualCatalogEntry(
  providerId: string,
  model: ManualModel,
  catalog: ProviderCatalogModel[],
): ProviderCatalogModel | undefined {
  return catalog.find(
    (entry) =>
      entry.modelID === model.model_id &&
      (entry.sourceProviderID === providerId || entry.providerID === providerId),
  );
}

export function manualUiState(
  providerId: string,
  model: ManualModel,
  catalog: ProviderCatalogModel[],
): ManualUiState {
  if (!model.enabled) return "hidden";
  const entry = findManualCatalogEntry(providerId, model, catalog);
  if (!entry) return "unavailable";
  return entry.status === "cache" ? "stale" : "available";
}

export function providerStatusLabel(status?: ProviderCatalogStatus | string) {
  switch (status) {
    case "live":
      return "Каталог актуален";
    case "cache":
      return "Последняя успешная версия";
    case "unauthorized":
      return "API-ключ отклонён";
    case "unavailable":
      return "Каталог недоступен";
    default:
      return "Статус неизвестен";
  }
}

export function manualStateLabel(state: ManualUiState) {
  switch (state) {
    case "available":
      return "Проверена";
    case "stale":
      return "Проверка устарела";
    case "hidden":
      return "Скрыта";
    case "unavailable":
      return "Недоступна";
  }
}

export function humanizeModelError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  let serverMessage = raw;
  const jsonStart = raw.indexOf("{");
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(raw.slice(jsonStart)) as { error?: string };
      if (body.error) serverMessage = body.error;
    } catch {
      // Оставляем исходное сообщение: оно всё равно полезнее пустой ошибки.
    }
  }
  const message = serverMessage.toLowerCase();
  if (message.includes("key is not configured")) {
    return "Сначала подключите API-ключ этого провайдера.";
  }
  if (message.includes("not available with the configured key")) {
    return "Модель не отвечает с подключённым ключом. Проверьте ID, права ключа и endpoint.";
  }
  if (message.includes("invalid model endpoint")) {
    return "Endpoint отклонён. Используйте публичный HTTPS/HTTP адрес без локальных и служебных сетей.";
  }
  if (message.includes("openai-compatible")) {
    return "Свой endpoint сейчас поддерживается только для OpenAI-compatible API.";
  }
  if (message.includes("invalid model id")) {
    return "Некорректный Model ID.";
  }
  if (/\b401\b|unauthorized/.test(message)) {
    return "API-ключ отклонён провайдером.";
  }
  if (/\b403\b|forbidden/.test(message)) {
    return "У ключа нет доступа к этой модели.";
  }
  if (/timed out|timeout|network|fetch/.test(message)) {
    return "Провайдер не ответил вовремя. Повторите проверку позже.";
  }
  return "Не удалось выполнить операцию с моделью.";
}
