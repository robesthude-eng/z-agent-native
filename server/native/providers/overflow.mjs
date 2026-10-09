// Recognition of "the request does not fit into the model's context" errors.
//
// The wording of these errors differs for every provider and gateway, and the
// turn loop reacts to them by compacting the history harder and retrying the
// step, so a missed message ends the turn and a false positive shrinks the
// remembered context budget of the model for no reason.
//
// The pattern list and the exclusions are ported from opencode
// (https://github.com/sst/opencode, packages/llm/src/provider-error.ts),
// MIT License, Copyright (c) 2025 opencode. They add the phrasings of Gemini,
// xAI, GitHub Copilot, llama.cpp, Kimi, Mistral, MiniMax and others to the
// shorter expression z-agent used before (kept below as LEGACY_PATTERN, so
// nothing that was recognised before stops being recognised).
//
// Not ported: opencode also treats a bare "400/413 (no body)" as an overflow.
// z-agent's providerError() reports "<status> <statusText>" for any empty
// error body, so that rule would classify ordinary 400s as overflow and the
// turn loop would permanently shrink the learned budget of a healthy model.
// HTTP 413 is still recognised by status in isContextOverflowError().

export const CONTEXT_OVERFLOW_PATTERNS = Object.freeze([
  /prompt is too long/i,
  /request_too_large/i,
  /input is too long for requested model/i,
  /exceeds the context window/i,
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i,
  /input token count.*exceeds the maximum/i,
  /tokens in request more than max tokens allowed/i,
  /maximum prompt length is \d+/i,
  /reduce the length of the messages/i,
  /maximum context length is \d+ tokens/i,
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i,
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i,
  /exceeds the limit of \d+/i,
  /exceeds the available context size/i,
  /greater than the context length/i,
  /context window exceeds limit/i,
  /exceeded model token limit/i,
  /context[_ ]length[_ ]exceeded/i,
  /request entity too large/i,
  /context length is only \d+ tokens/i,
  /input length.*exceeds.*context length/i,
  /prompt too long; exceeded (?:max )?context length/i,
  /too large for model with \d+ maximum context length/i,
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i,
  /model_context_window_exceeded/i,
  /too many tokens/i,
  /token limit exceeded/i,
]);

// Rate limiting and transient outages often mention tokens too; they must be
// retried as they are, not answered by throwing context away.
const NOT_OVERFLOW_PATTERNS = Object.freeze([/^(throttling error|service unavailable):/i, /rate limit/i, /too many requests/i]);

// The expression z-agent used before the opencode list was added.
const LEGACY_PATTERN =
  /prompt (?:exceeds|is too long)|exceeds (?:the )?max(?:imum)? (?:length|context|tokens?)|context[_ ](?:length|window)(?:[_ ]exceeded)?|maximum context length|too many (?:input )?tokens|input (?:is )?too long|request too large|reduce the length/i;

export function isContextOverflowMessage(message) {
  const text = String(message ?? '');
  if (!text || NOT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text))) return false;
  return LEGACY_PATTERN.test(text) || CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(text));
}
