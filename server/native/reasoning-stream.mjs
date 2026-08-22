// Живое разделение потока модели на «рассуждения» и «ответ».
//
// Раньше это решение принималось в двух несогласованных местах и только
// частично: `callOpenAI` разбирал прямо в цикле SSE один тег <think>, а всё,
// что провайдер не помечал типом, `liveTextSink` угадывал по первому символу
// чанка. Остальное — `thinking_delta` у Anthropic, `thought: true` у Gemini,
// поле `reasoning` у шлюзов, теги <thinking>/<thought>/<reasoning> — уезжало в
// ленту обычным текстом, и мысли модели оказывались в чате. В карточку они
// переезжали только в конце хода, когда `sanitizeAssistantParts` пересобирал
// уже сохранённое сообщение: отсюда и «после остановки скрыто как положено».
//
// Здесь нет ни сети, ни состояния сообщения: на вход идут куски потока, на
// выход — отрезки с явным родом ('reasoning' | 'text'). Поэтому разбор
// проверяется перебором строк в tests/reasoning-stream.test.mjs, а не глазами
// на живом чате.

export const REASONING_OPEN_TAGS = Object.freeze(['<think>', '<thinking>', '<thought>', '<reasoning>']);
export const REASONING_CLOSE_TAGS = Object.freeze(['</think>', '</thinking>', '</thought>', '</reasoning>']);

// Русский ответ после английского монолога: та же граница, что и в
// splitReasoningFromContent, чтобы живой разбор и финальная страховка
// не спорили друг с другом.
const RU_ANSWER_BOUNDARY = /([.?!]\s*|\n\s*)([А-ЯЁ][а-яё]+(?:!|\?|\.|\s*👋|\s*[,\s]))/;

const MAX_TAG_LENGTH = Math.max(...[...REASONING_OPEN_TAGS, ...REASONING_CLOSE_TAGS].map((tag) => tag.length));

// Сколько символов ждём в режиме угадывания, прежде чем признать поток текстом:
// эмодзи, отступы и markdown-обвязка сами по себе ничего не говорят о роде.
const DETECT_LIMIT = 48;

function firstTagIndex(buffer, tags) {
  let index = -1;
  let match = '';
  for (const tag of tags) {
    const at = buffer.indexOf(tag);
    if (at >= 0 && (index === -1 || at < index)) {
      index = at;
      match = tag;
    }
  }
  return { index, tag: match };
}

// Длина хвоста, который может оказаться началом тега, разрезанного между
// чанками. Такой хвост придерживаем, иначе '<thi' мелькнёт в чате.
function partialTagTail(buffer, tags) {
  const max = Math.min(MAX_TAG_LENGTH - 1, buffer.length);
  for (let length = max; length > 0; length -= 1) {
    const tail = buffer.slice(buffer.length - length);
    if (tags.some((tag) => tag.length > length && tag.startsWith(tail))) return length;
  }
  return 0;
}

function startsWithLatinLetter(text) {
  const letter = /\p{L}/u.exec(text);
  return Boolean(letter) && /[a-zA-Z]/.test(letter[0]);
}

/**
 * Собирает разделитель потока.
 *
 * @param {(segment: { kind: 'reasoning' | 'text', text: string, replace?: boolean }) => void} onSegment
 *   Вызывается на каждый готовый отрезок. `replace: true` значит «текущая
 *   вспышка рассуждений целиком равна этому тексту»: живое угадывание могло
 *   отдать в карточку начало ответа, и его надо забрать назад.
 */
export function createReasoningSplitter(onSegment) {
  let text = '';
  let reasoning = '';
  let tail = '';
  let insideTag = false;
  let lastPlainKind = null;
  let mode = 'detect'; // режим для непомеченного потока: 'detect' | 'reasoning' | 'text'
  let detectBuffer = '';
  let monologue = '';
  let monologueBase = 0; // длина reasoning до начала текущей угаданной вспышки

  const emit = (kind, chunk, replace = false) => {
    if (!chunk) return;
    if (kind === 'reasoning') reasoning = replace ? reasoning.slice(0, monologueBase) + chunk : reasoning + chunk;
    else text += chunk;
    onSegment(replace ? { kind, text: chunk, replace: true } : { kind, text: chunk });
  };

  const pushMonologue = (chunk) => {
    monologue += chunk;
    const found = RU_ANSWER_BOUNDARY.exec(monologue);
    if (!found) {
      emit('reasoning', chunk);
      return;
    }
    const boundary = found.index + found[1].length;
    const thought = monologue.slice(0, boundary).trim();
    const answer = monologue.slice(boundary);
    // Начало ответа уже могло улететь в карточку внутри этого же чанка:
    // переписываем вспышку целиком, а не досылаем разницу.
    emit('reasoning', thought, true);
    mode = 'text';
    monologue = '';
    emit('text', answer);
  };

  const pushUntyped = (chunk) => {
    if (mode === 'text') {
      emit('text', chunk);
      return;
    }
    if (mode === 'reasoning') {
      pushMonologue(chunk);
      return;
    }
    detectBuffer += chunk;
    const hasLetter = /\p{L}/u.test(detectBuffer);
    if (!hasLetter && detectBuffer.length < DETECT_LIMIT) return;
    const decided = detectBuffer;
    detectBuffer = '';
    if (hasLetter && startsWithLatinLetter(decided)) {
      mode = 'reasoning';
      monologueBase = reasoning.length;
      monologue = '';
      pushMonologue(decided);
      return;
    }
    mode = 'text';
    emit('text', decided);
  };

  const pushPlain = (chunk, kind) => {
    if (!chunk) return;
    if (kind === 'text') emit('text', chunk);
    else pushUntyped(chunk);
  };

  const consume = (chunk, kind) => {
    tail += chunk;
    while (tail) {
      if (insideTag) {
        const close = firstTagIndex(tail, REASONING_CLOSE_TAGS);
        if (close.index >= 0) {
          emit('reasoning', tail.slice(0, close.index));
          tail = tail.slice(close.index + close.tag.length);
          insideTag = false;
          // Модель сама отделила мысли от ответа: угадывать по первому символу
          // дальше не нужно, всё после тега — ответ.
          mode = 'text';
          detectBuffer = '';
          monologue = '';
          continue;
        }
        const hold = partialTagTail(tail, REASONING_CLOSE_TAGS);
        emit('reasoning', tail.slice(0, tail.length - hold));
        tail = hold ? tail.slice(tail.length - hold) : '';
        return;
      }
      const open = firstTagIndex(tail, REASONING_OPEN_TAGS);
      if (open.index >= 0) {
        pushPlain(tail.slice(0, open.index), kind);
        tail = tail.slice(open.index + open.tag.length);
        insideTag = true;
        continue;
      }
      const hold = partialTagTail(tail, REASONING_OPEN_TAGS);
      pushPlain(tail.slice(0, tail.length - hold), kind);
      tail = hold ? tail.slice(tail.length - hold) : '';
      return;
    }
  };

  return {
    /**
     * @param {string} delta кусок потока
     * @param {'reasoning' | 'text' | null} type род, если провайдер его сообщил
     */
    push(delta, type = null) {
      const chunk = delta == null ? '' : String(delta);
      if (!chunk) return;
      if (type === 'reasoning') {
        // Провайдер уже пометил кусок мыслями — тегов внутри не ищем.
        emit('reasoning', chunk);
        return;
      }
      lastPlainKind = type === 'text' ? 'text' : null;
      consume(chunk, lastPlainKind);
    },
    /** Отдать придержанные хвосты: поток кончился, ждать продолжения нечего. */
    flush() {
      if (tail) {
        const rest = tail;
        tail = '';
        if (insideTag) emit('reasoning', rest);
        else pushPlain(rest, lastPlainKind);
      }
      if (detectBuffer) {
        const rest = detectBuffer;
        detectBuffer = '';
        // Поток закончился, не показав ни одной буквы: это не монолог.
        mode = 'text';
        emit('text', rest);
      }
    },
    /** Накопленный ответ и мысли: ответ идёт в историю, мысли — только в UI. */
    snapshot() {
      return { text, reasoning };
    },
  };
}
