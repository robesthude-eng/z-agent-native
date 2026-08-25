/**
 * LLM Providers and Model Routing Facade for Z-Agent Native.
 * Modular implementations live in server/native/providers/*.
 */

export {
  RELAY_BASE,
  RELAY_ENABLED,
  relayStatus,
  idleTimeoutSignal,
  isRateLimitProviderError,
  isNetworkTransportError,
  isModelUnavailableError,
  publicProviderErrorMessage,
  setProviderTransportForTests,
  providerAuth,
  assertSafeProviderUrl,
  routedProviderTarget,
  fetchJson,
  fetchSse,
  providerFetch,
} from './providers/transport.mjs';

export {
  FIXTURE_PROVIDER_ID,
  FIXTURE_MODEL_ID,
  fixtureProviderEnabled,
  fixtureResponse,
  builtInSpecs,
  effectiveSpecs,
  isBuiltInProvider,
  providerSpecs,
  providerList,
  fetchModels,
  buildCatalog,
  resolveModel,
} from './providers/catalog.mjs';

export {
  parseToolArguments,
  isIncompleteToolCall,
  toolCallFromParsed,
  parseDataUrl,
  openAiMessages,
  anthropicMessages,
  googleContents,
  callOpenAI,
  callAnthropic,
  callGoogle,
  callOllama,
} from './providers/streaming.mjs';

export {
  MEDIA_UNSUPPORTED_KINDS,
  MEDIA_MAX_RESPONSE_BYTES,
  MEDIA_REQUEST_TIMEOUT_MS,
  assertMediaCapableProvider,
  mediaEndpointUrl,
  mediaHeaders,
  callProviderJson,
  callProviderBinary,
} from './providers/media.mjs';

export {
  callModel,
  probeModel,
} from './providers/caller.mjs';

// Backward-compatibility and test invariant references:
// err?.publicMessage (prepared explanation takes precedence)
