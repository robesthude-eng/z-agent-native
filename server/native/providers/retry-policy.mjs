// Small pieces of retry policy for provider calls.
//
// Ported from opencode (https://github.com/sst/opencode,
// packages/opencode/src/session/retry.ts), MIT License, Copyright (c) 2025
// opencode: the list of error wordings that mean "try again" and the +25 %
// jitter that keeps parallel sessions from retrying a throttled provider in
// lockstep.
//
// Adapted for z-agent:
// - the status codes in the first pattern are matched as whole numbers, so
//   "position 5003" is not read as an HTTP 500;
// - `getaddrinfo`/`ENOTFOUND` are left out: an unknown host is almost always a
//   wrong base URL, which waiting does not fix (EAI_AGAIN, the transient DNS
//   failure, is still retried through the transport's own network list).

export const RETRY_JITTER_FACTOR = 0.25;

export const RETRYABLE_MESSAGE_PATTERNS = Object.freeze([
  /\b(?:429|500|502|503|504|524)\b/i,
  /rate increased too quickly|rate limit|rate-limit|rate_limit|too many requests/i,
  /overloaded|service unavailable|service_unavailable|service-unavailable|internal error|internal_error|internal server error|server error|server_error|server-error|provider returned error|provider_returned_error|provider-returned-error/i,
  /terminated|fetch failed|failed to fetch|network[-_\s]error|upstream connect|connection error|connection refused|connection lost|socket connection was closed|socket hang up|reset before headers|eai_again|econnrefused|econnreset|etimedout/i,
  /^timeout$|\b(?:request|response|connection|network|stream|read) (?:timeout|timed out|time out)\b/i,
  /try your request again|retry your request|resource exhausted|resource_exhausted/i,
  /\btry again (?:later|in\b)|\b(?:currently|temporarily) at capacity\b/i,
]);

export function matchesRetryableMessage(value) {
  return typeof value === 'string' && RETRYABLE_MESSAGE_PATTERNS.some((pattern) => pattern.test(value));
}

/** `ms` plus up to RETRY_JITTER_FACTOR of itself; `random` is a number in [0, 1). */
export function jittered(ms, random = Math.random()) {
  return Math.ceil(ms + ms * RETRY_JITTER_FACTOR * random);
}
