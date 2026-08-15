export interface ProviderInfo {
  id: string;
  name: string;
  color: string;
  models: string;
  keyHint: string;
  docsUrl: string;
}

/**
 * UI metadata only. The selectable model catalog is owned by the native
 * runtime and comes from /api/providers/models.
 */
export const PROVIDERS: ProviderInfo[] = [
  { id: "anthropic", name: "Anthropic", color: "#d97757", models: "Claude", keyHint: "sk-ant-...", docsUrl: "https://console.anthropic.com/settings/keys" },
  { id: "openai", name: "OpenAI", color: "#10a37f", models: "GPT и o-серия", keyHint: "sk-...", docsUrl: "https://platform.openai.com/api-keys" },
  { id: "google", name: "Google", color: "#4285f4", models: "Gemini", keyHint: "AIza...", docsUrl: "https://aistudio.google.com/apikey" },
  { id: "xai", name: "xAI", color: "#111827", models: "Grok", keyHint: "xai-...", docsUrl: "https://console.x.ai" },
  { id: "deepseek", name: "DeepSeek", color: "#4d6bfe", models: "DeepSeek", keyHint: "sk-...", docsUrl: "https://platform.deepseek.com/api_keys" },
  { id: "groq", name: "Groq", color: "#f55036", models: "Открытые модели", keyHint: "gsk_...", docsUrl: "https://console.groq.com/keys" },
  { id: "mistral", name: "Mistral", color: "#ff7000", models: "Mistral, Codestral", keyHint: "API key", docsUrl: "https://console.mistral.ai/api-keys" },
  { id: "openrouter", name: "OpenRouter", color: "#8a3ffc", models: "Агрегатор моделей", keyHint: "sk-or-...", docsUrl: "https://openrouter.ai/keys" },
  { id: "together", name: "Together AI", color: "#0f6fff", models: "Открытые модели", keyHint: "API key", docsUrl: "https://api.together.ai/settings/api-keys" },
  { id: "zai", name: "Z.ai", color: "#4f46e5", models: "GLM", keyHint: "API key", docsUrl: "https://z.ai" },
  { id: "anymodel", name: "AnyModel", color: "#14b8a6", models: "Агрегатор", keyHint: "API key", docsUrl: "https://anymodel.org/app/api-keys" },
  { id: "kiwi", name: "Kiwi LLM", color: "#22c55e", models: "Агрегатор", keyHint: "Kiwi_live_...", docsUrl: "https://www.kiwillm.in/dashboard" },
];
