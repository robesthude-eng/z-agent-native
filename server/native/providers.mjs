/**
 * LLM Providers and Model Routing Facade for Z-Agent Native.
 * Modular implementations live in server/native/providers/*.
 */


export {
  callModel,
  probeModel,
} from './providers/caller.mjs';

export {
  buildCatalog,
  builtInSpecs,
  effectiveSpecs,
  FIXTURE_MODEL_ID,
  FIXTURE_PROVIDER_ID,
  fetchModels,
  fixtureProviderEnabled,
  fixtureResponse,
  isBuiltInProvider,
  providerList,
  providerSpecs,
  resolveModel,
} from './providers/catalog.mjs';
export {
  assertMediaCapableProvider,
  callProviderBinary,
  callProviderJson,
  MEDIA_MAX_RESPONSE_BYTES,
  MEDIA_REQUEST_TIMEOUT_MS,
  MEDIA_UNSUPPORTED_KINDS,
  mediaEndpointUrl,
  mediaHeaders,
} from './providers/media.mjs';
export {
  anthropicMessages,
  callAnthropic,
  callGoogle,
  callOllama,
  callOpenAI,
  googleContents,
  isIncompleteToolCall,
  openAiMessages,
  parseDataUrl,
  parseToolArguments,
  toolCallFromParsed,
} from './providers/streaming.mjs';
export {
  assertSafeProviderUrl,
  fetchJson,
  fetchSse,
  idleTimeoutSignal,
  isModelUnavailableError,
  isNetworkTransportError,
  isRateLimitProviderError,
  providerAuth,
  providerFetch,
  publicProviderErrorMessage,
  RELAY_BASE,
  RELAY_ENABLED,
  relayStatus,
  routedProviderTarget,
  setProviderTransportForTests,
} from './providers/transport.mjs';

// Backward-compatibility and test invariant references:
// err?.publicMessage (prepared explanation takes precedence)
