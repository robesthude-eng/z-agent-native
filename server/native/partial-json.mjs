/**
 * Best-effort reading of a JSON document that is still being streamed.
 *
 * Providers send tool-call arguments token by token. Waiting for the closing
 * brace before showing anything makes a large `write` look frozen for as long
 * as the model needs to produce the file. This repairs the prefix received so
 * far (closes an open string, drops a dangling key/comma/number, closes the open
 * containers) so the UI can show the file path and the content as it arrives.
 *
 * It is a display aid only: the real call is always parsed from the final,
 * complete arguments.
 */

function scan(text) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') stack.pop();
  }
  return { stack, inString, escaped };
}

const DANGLING_KEY_WITH_COLON = /,?\s*"(?:[^"\\]|\\.)*"\s*:\s*$/;
const DANGLING_STRING = /,?\s*"(?:[^"\\]|\\.)*"\s*$/;
const TRAILING_COMMA = /,\s*$/;
const PARTIAL_NUMBER = /[-+.eE]+$/;
const PARTIAL_LITERAL = /(?:t|tr|tru|f|fa|fal|fals|n|nu|nul)$/;

const TRIMS = [(s) => s, (s) => s.replace(TRAILING_COMMA, ''), (s) => s.replace(PARTIAL_NUMBER, ''), (s) => s.replace(PARTIAL_LITERAL, '')];
const DROPS = [(s) => s, (s) => s.replace(DANGLING_KEY_WITH_COLON, ''), (s) => s.replace(DANGLING_STRING, '')];

export function parsePartialJson(raw) {
  const text = String(raw ?? '');
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    /* fall through to repair */
  }

  const { stack, inString, escaped } = scan(text);
  let base = text;
  if (inString) {
    if (escaped) base = base.slice(0, -1);
    // A \uXXXX escape cut in the middle is not valid yet.
    base = base.replace(/\\u[0-9a-fA-F]{0,3}$/, '');
    base += '"';
  }
  const closers = [...stack].reverse().join('');
  for (const trim of TRIMS) {
    for (const drop of DROPS) {
      const candidate = drop(trim(base));
      try {
        return JSON.parse(candidate + closers);
      } catch {
        /* try the next repair */
      }
    }
  }
  return null;
}

const PREVIEW_INPUT_MAX = 400;
const PREVIEW_OUTPUT_TAIL = 4000;
// Keys that carry file bodies / patches. They go to the live output pane, not
// into the (small) input summary, whatever their current length is.
const BODY_KEYS = ['content', 'newText', 'new_string', 'newString', 'patch', 'patchText', 'text', 'code', 'script'];

function tail(text, max) {
  return text.length > max ? `[…показан только конец]\n${text.slice(-max)}` : text;
}

/**
 * Small, bounded summary of arguments received so far: short scalar fields for
 * the card header (path, command, pattern …) and the tail of the body being
 * written for the live pane. Never the whole body — it is re-sent on every
 * update.
 */
export function toolArgsPreview(rawArgs) {
  const parsed = rawArgs && typeof rawArgs === 'object' ? rawArgs : parsePartialJson(rawArgs);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { input: {}, output: '' };
  const input = {};
  let body = '';
  for (const key of BODY_KEYS) {
    const value = parsed[key];
    if (typeof value === 'string' && value) {
      body = value;
      break;
    }
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (BODY_KEYS.includes(key)) continue;
    if (typeof value === 'string') {
      if (value.length <= PREVIEW_INPUT_MAX) input[key] = value;
      else if (!body || value.length > body.length) body = value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      input[key] = value;
    }
  }
  return { input, output: body ? tail(body, PREVIEW_OUTPUT_TAIL) : '' };
}
