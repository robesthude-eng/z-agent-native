export function splitReasoningFromContent(rawText) {
  const text = String(rawText || '').trim();
  if (!text || text.length < 15) return { reasoning: '', text };

  // 1. Explicit <think> or <thought> tags
  if (text.includes('<think>')) {
    const parts = text.split('</think>');
    const thought = parts[0].replace('<think>', '').trim();
    const body = (parts[1] || '').trim();
    return { reasoning: thought, text: body || thought };
  }
  if (text.includes('<thought>')) {
    const parts = text.split('</thought>');
    const thought = parts[0].replace('<thought>', '').trim();
    const body = (parts[1] || '').trim();
    return { reasoning: thought, text: body || thought };
  }

  // 2. English internal monologue transitioning into Russian user response
  const m = new RegExp('([.?!]\\s*|\\n\\s*)([А-ЯЁ][а-яё]+(?:!|\\?|\\.|\\s*👋|\\s*[,\\s]))').exec(text);
  if (m) {
    const boundary = m.index + m[1].length;
    const prefix = text.slice(0, boundary).trim();
    const suffix = text.slice(boundary).trim();
    const latinChars = (prefix.match(/[a-zA-Z]/g) || []).length;
    if (latinChars >= 25 && (latinChars / Math.max(1, prefix.length)) > 0.4 && suffix) {
      return { reasoning: prefix, text: suffix };
    }
  }

  return { reasoning: '', text };
}
