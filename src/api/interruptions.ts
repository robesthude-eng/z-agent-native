/**
 * Единая форма прерывания хода — этап 2.1.
 *
 * Инвариант контракта: I-16 (ход в состоянии ожидания пользователя никогда не
 * считается зависшим) и I-32 (неопределённое состояние названо словами).
 *
 * У агента два способа остановиться и спросить человека, и до этого модуля они
 * не имели ничего общего:
 *
 * | | разрешение | вопрос |
 * | нагрузка | `{tool, input}` | массив `{question, options, ...}` |
 * | где живёт | событие `permission.asked` | tool-часть в ленте сообщений |
 * | как ответить | `POST /permissions/:id` | `POST /question/:id/reply` |
 * | словарь ответа | `once` / `always` / `reject` | произвольная строка |
 *
 * Пользователю разница не видна и не нужна: в обоих случаях ход стоит и не
 * продолжится без него. Поэтому нормализация делается здесь, на клиенте — обе
 * нагрузки у него уже есть, сервер править не требуется.
 *
 * Модуль намеренно чистый: ни React, ни `fetch`. Он отвечает на два вопроса —
 * «что показать» (`Interruption`) и «что отправить» (`replyPlan`), — и оба
 * ответа можно проверить тестом, не поднимая интерфейс. Именно этого не хватало
 * прежнему коду: решение об отправке жило внутри `useCallback` в
 * `ToolCard.tsx`, и то, что оно ОТМЕНЯЕТ ход, нигде не было названо.
 */

/**
 * Словарь ответа на разрешение в native permission protocol (
 * `allow`/`deny`). Сервер проверяет тело строго: всё остальное — это 400.
 *
 * Порядок здесь — порядок кнопок в полосе, и он же порядок по последствиям:
 * сначала самое узкое разрешение, потом широкое, потом отказ.
 */
export const PERMISSION_VALUES = ["once", "always", "reject"] as const;

export type PermissionResponse = (typeof PERMISSION_VALUES)[number];

/** @param v ответ, пришедший из интерфейса */
export function isPermissionResponse(
  v: string | undefined,
): v is PermissionResponse {
  return (PERMISSION_VALUES as readonly (string | undefined)[]).includes(v);
}

export type InterruptionKind = "permission" | "question";

export interface InterruptionOption {
  /** Надпись на кнопке. */
  label: string;
  /** Что уйдёт на сервер. Для разрешения это enum, для вопроса — сам label. */
  value: string;
  /** Пояснение под кнопкой. Пустая строка означает «пояснения нет». */
  description: string;
  /**
   * Отказ, а не выбор. Рисуется тише и не получает фокус по умолчанию:
   * фокус на кнопке, отклоняющей запрос, превращает Enter в отказ.
   */
  denial: boolean;
}

export interface Interruption {
  kind: InterruptionKind;
  /**
   * Идентификатор у движка. У вопроса из ленты его может не быть вовсе —
   * поэтому `null` здесь законное значение, а не признак ошибки разбора.
   */
  id: string | null;
  /** Заголовок полосы: «Запрос разрешения» / «Вопрос агента». */
  title: string;
  /** Одна строка: чему даётся разрешение или что именно спрашивают. */
  prompt: string;
  /** Главная деталь — команда, путь, URL. Показывается моноширинным. */
  detail: string;
  options: InterruptionOption[];
  /** Разрешён ли произвольный ответ текстом. У разрешения — никогда. */
  allowCustom: boolean;
  /** Сырая нагрузка для раскрывающегося блока «все параметры». */
  raw: unknown;
}

/* ------------------------------------------------------------------ */
/* Нормализация                                                        */
/* ------------------------------------------------------------------ */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (o: Record<string, unknown>, k: string): string =>
  typeof o[k] === "string" ? (o[k] as string) : "";

/**
 * Первое непустое из нескольких полей. Названия у движка плавают между
 * версиями (`question`/`text`, `label`/`text`, `description`/`desc`), и
 * перебор синонимов — не аккуратность, а совместимость.
 */
const pick = (o: Record<string, unknown>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = str(o, k);
    if (v) return v;
  }
  return "";
};

/**
 * Три ответа на разрешение — не три равноправные кнопки.
 *
 * `once` — безопасный умолчальный выбор: только этот вызов. `always` шире по
 * последствиям, `reject` — отказ.
 *
 * Подписи выводятся из `PERMISSION_VALUES`, а не перечисляются рядом: два
 * списка одних и тех же значений расходятся молча, и разошлись бы именно
 * здесь — добавленный в словарь ответ не получил бы кнопки, а лишняя кнопка
 * отправляла бы слово, на которое сервер отвечает 400.
 */
const PERMISSION_LABELS: Record<
  PermissionResponse,
  { label: string; description: string; denial: boolean }
> = {
  once: { label: "Разрешить", description: "Только этот вызов", denial: false },
  always: {
    label: "Всегда",
    description: "До конца текущей сессии",
    denial: false,
  },
  reject: { label: "Отклонить", description: "", denial: true },
};

const PERMISSION_OPTIONS: InterruptionOption[] = PERMISSION_VALUES.map((v) => ({
  value: v,
  ...PERMISSION_LABELS[v],
}));

export interface PermissionLike {
  id?: unknown;
  tool?: unknown;
  input?: unknown;
}

/**
 * Форма перевода нагрузки в текст. `detail?: string | undefined` записано
 * именно так намеренно: в проекте включён `exactOptionalPropertyTypes`, при
 * котором `detail?: string` означает «строка или поля нет», и функция,
 * возвращающая `detail: undefined`, под такой тип не подходит.
 */
export interface ToolPresentation {
  action: string;
  detail?: string | undefined;
}

/**
 * @param req запрос разрешения, как он пришёл в `permission.asked`
 * @param present перевод пары (tool, input) в человеческую формулировку;
 *   передаётся снаружи, потому что это вопрос текста, а не протокола
 */
export function normalizePermission(
  req: PermissionLike,
  present: (tool: string, input: unknown) => ToolPresentation,
): Interruption {
  const tool = typeof req.tool === "string" && req.tool ? req.tool : "tool";
  const { action, detail } = present(tool, req.input);
  return {
    kind: "permission",
    id: typeof req.id === "string" && req.id ? req.id : null,
    title: "Запрос разрешения",
    prompt: action,
    detail: detail ?? "",
    options: PERMISSION_OPTIONS,
    // У разрешения произвольного ответа нет и быть не может: сервер проверяет
    // тело строго, и всё, кроме трёх значений enum, — это 400.
    allowCustom: false,
    raw: req.input,
  };
}

/**
 * @param q один вопрос из нагрузки инструмента `question`
 * @param id идентификатор ожидающего вопроса у движка, если он известен
 */
export function normalizeQuestion(q: unknown, id: string | null): Interruption {
  const rec = isRecord(q) ? q : {};
  const rawOptions = Array.isArray(rec.options) ? rec.options : [];
  const options: InterruptionOption[] = rawOptions.map((o) => {
    if (typeof o === "string") {
      return { label: o, value: o, description: "", denial: false };
    }
    const or = isRecord(o) ? o : {};
    const label = pick(or, "label", "text");
    return {
      label,
      // Отправляется label, а не id: сервер вопросов принимает строки ответа,
      // и подстановка id дала бы агенту непрозрачный код вместо слов.
      value: label,
      description: pick(or, "description", "desc"),
      denial: false,
    };
  });
  const allowCustom =
    typeof rec.allowCustomResponse === "boolean"
      ? rec.allowCustomResponse
      : typeof rec.allowCustom === "boolean"
        ? rec.allowCustom
        : true;
  return {
    kind: "question",
    id,
    title: "Вопрос агента",
    prompt: pick(rec, "question", "text"),
    detail: "",
    options,
    allowCustom,
    raw: q,
  };
}

/* ------------------------------------------------------------------ */
/* Протокол ответа                                                     */
/* ------------------------------------------------------------------ */

/**
 * Что именно отправить. Вопрос либо получает reply в существующий pending
 * request, либо остаётся на карточке: превращать ответ в новый user-turn нельзя.
 */
export type ReplyPlan =
  | { transport: "permission"; id: string; response: PermissionResponse }
  | { transport: "question"; id: string; answers: string[][] }
  | { transport: "none"; reason: string };

export interface ReplyContext {
  /**
   * Идентификатор ожидающего вопроса, подтверждённый сервером, либо `null`,
   * если request ещё не успел появиться в Question API.
   */
  pendingQuestionId?: string | null;
}

/**
 * Каким путём уйдёт ответ — БЕЗ учёта того, что именно выбрано.
 *
 * Отдельно от `replyPlan`, чтобы интерфейс мог заранее понять: request уже
 * подтверждён и ответ можно отправлять, либо надо ещё дождаться `/question`.
 *
 * @param interruption нормализованное прерывание
 * @param ctx что известно о серверной стороне
 */
export function replyTransport(
  interruption: Interruption,
  ctx: ReplyContext = {},
): ReplyPlan["transport"] {
  if (interruption.kind === "permission") {
    return interruption.id ? "permission" : "none";
  }
  // Вопрос НИКОГДА не превращаем в новое user-message. Native question tool
  // блокируется на pending request; единственный корректный ответ — reply в
  // тот же request. Если id ещё не виден, UI ждёт/повторяет GET /question и
  // оставляет карточку активной вместо abort текущего turn.
  return (ctx.pendingQuestionId ?? interruption.id) ? "question" : "none";
}

/**
 * @param interruption нормализованное прерывание
 * @param answer выбранные значения; для разрешения ровно одно из enum
 * @param ctx что известно о серверной стороне на момент отправки
 */
export function replyPlan(
  interruption: Interruption,
  answer: string[],
  ctx: ReplyContext = {},
): ReplyPlan {
  // Обёртка над пакетным планом, а не второй его экземпляр. Одиночный ответ —
  // частный случай пакета из одного, и написанный отдельно он разошёлся бы с
  // пакетным молча: правку внесли бы в одну ветку, а инвариант отмены хода
  // проверяется на другой.
  return batchReplyPlan([interruption], [answer], ctx);
}

/**
 * План ответа сразу на ВСЕ вопросы одного вызова инструмента.
 *
 * Зачем пакет. Один вызов `question` несёт массив вопросов, а Question API
 * принимает ответы на весь вызов списком списков. Поэтому UI собирает ответы
 * по очереди и делает один reply в тот же pending request.
 *
 * Ответ по протоколу пакетным был всегда: `answers` у движка — список списков,
 * где внешний уровень это вопрос. Одиночная отправка заполняла его наполовину.
 *
 * @param interruptions вопросы одного вызова в порядке показа
 * @param answers выбранные значения по каждому; позиция значит вопрос
 * @param ctx что известно о серверной стороне на момент отправки
 */
export function batchReplyPlan(
  interruptions: readonly Interruption[],
  answers: readonly (readonly string[])[],
  ctx: ReplyContext = {},
): ReplyPlan {
  const head = interruptions[0];
  if (!head) return { transport: "none", reason: "нечего отправлять" };

  const values = interruptions.map((_, idx) =>
    (answers[idx] ?? []).map((a) => a.trim()).filter(Boolean),
  );
  if (values.every((v) => v.length === 0)) {
    return { transport: "none", reason: "пустой ответ" };
  }

  switch (replyTransport(head, ctx)) {
    case "permission": {
      // Разрешения не пакетируются: у каждого свой идентификатор и свой ответ
      // из enum. Пакет здесь означал бы, что второе разрешение молча ушло с
      // ответом первого.
      if (interruptions.length > 1) {
        return {
          transport: "none",
          reason: "разрешения отправляются по одному",
        };
      }
      const v = values[0]?.[0];
      if (!isPermissionResponse(v)) {
        // Сервер отвечает 400 на любое другое слово. Отправить и посмотреть —
        // значит оставить ход стоять, а пользователю показать сетевую ошибку
        // вместо причины.
        return { transport: "none", reason: `недопустимый ответ: ${v}` };
      }
      // Идентификатор проверен внутри `replyTransport`: без него транспорт
      // «permission» не выбирается вовсе.
      return {
        transport: "permission",
        id: head.id ?? "",
        response: v,
      };
    }
    case "question":
      return {
        transport: "question",
        id: ctx.pendingQuestionId ?? head.id ?? "",
        // Движок принимает ответы по вопросам списком списков: внешний
        // уровень — вопрос, внутренний — выбранные варианты. Позиции
        // сохраняются целиком, включая пустые: сдвиг превратил бы ответ на
        // третий вопрос в ответ на второй.
        answers: values.map((v) => [...v]),
      };
    case "none":
      return {
        transport: "none",
        reason:
          head.kind === "question"
            ? "вопрос ещё не подтверждён сервером"
            : "нет идентификатора разрешения",
      };
    default:
      return { transport: "none", reason: "неизвестный транспорт ответа" };
  }
}

/**
 * Разбор legacy-ответа из старой истории (до прямого Question API).
 * Новая отправка эту строку НЕ создаёт; функция нужна только для чтения уже
 * сохранённых чатов, где ответ действительно был отдельным user-message.
 */
export function answerAsMessage(
  interruption: Interruption,
  values: string[],
): string {
  const ctx = interruption.prompt.trim();
  const body = values.join(", ");
  return ctx ? `${ctx}: ${body}` : body;
}

/**
 * Отменяет ли план ход. Сохранено как явный контракт: ответ на permission или
 * question не должен порождать abort текущего turn.
 */
export function planCancelsTurn(_plan: ReplyPlan): boolean {
  // Ответ на question теперь всегда идёт через Question API и продолжает тот
  // же tool-call. Ни один допустимый план ответа не отменяет текущий ход.
  return false;
}

/* ------------------------------------------------------------------ */
/* Что показывать в полосе                                             */
/* ------------------------------------------------------------------ */

/**
 * До скольких строк сворачивается длинный вопрос в полосе.
 *
 * Полоса висит над композером, и её высота — общий ресурс с перепиской.
 * Предсказуемая высота дороже одного лишнего клика: развернуть можно, а
 * закрытую полосой переписку не вернуть иначе как ответом.
 *
 * Согласовано 31.07.2026.
 */
export const BAR_COLLAPSE_LINES = 3;

/**
 * Флаг сборки. Выключен по умолчанию: пока он выключен, разрешение показывает
 * прежний `PermissionDialog`, а вопрос — карточка в ленте. Принцип выката
 * требует, чтобы новый показ можно было убрать переключателем, а не откатом
 * сборки, — тем более что полоса перекрывает переписку и ошибка в ней видна
 * каждому пользователю сразу.
 */
export function isInterruptionBarEnabled(): boolean {
  try {
    return import.meta.env?.VITE_INTERRUPTION_BAR !== "0";
  } catch {
    return true;
  }
}

/**
 * Примерное число знаков в строке полосы. Точную высоту знает только раскладка,
 * поэтому свёртка делается по CSS (`line-clamp`), а это число нужно лишь
 * затем, чтобы РЕШИТЬ, показывать ли кнопку «показать целиком»: рисовать её у
 * короткого вопроса значит обещать скрытое, которого нет.
 */
const BAR_CHARS_PER_LINE = 64;

export interface BarPresentation {
  /** Показывать ли полосу вообще. */
  visible: boolean;
  /** Прерывание, которое сейчас ждёт ответа, либо `null`. */
  active: Interruption | null;
  /** Сколько ещё прерываний стоит за активным. 0 — очередь пуста. */
  queued: number;
  /** Нужна ли кнопка «показать целиком». */
  collapsible: boolean;
}

/**
 * Что показать в полосе прерываний.
 *
 * Одно прерывание за раз — намеренно. Полоса перекрывает переписку, и очередь
 * из карточек перекрыла бы её тем сильнее, чем больше агент спрашивает. Число
 * ожидающих при этом видно, иначе ответ выглядел бы так, будто ничего не
 * изменилось.
 *
 * Порядок «разрешение раньше вопроса» задан здесь, а не подразумевается
 * порядком в массиве: разрешение блокирует конкретный вызов инструмента, и
 * ответ на вопрос без него всё равно не сдвинет ход с места. На практике
 * разрешения подтверждаются автоматически и до полосы доходят лишь аварийные —
 * тем более незачем заставлять человека искать их за вопросом.
 *
 * @param interruptions всё, что ждёт ответа
 */
export function barPresentation(
  interruptions: readonly Interruption[],
): BarPresentation {
  const ordered = [
    ...interruptions.filter((i) => i.kind === "permission"),
    ...interruptions.filter((i) => i.kind === "question"),
  ];
  const active = ordered[0] ?? null;
  if (!active) {
    return { visible: false, active: null, queued: 0, collapsible: false };
  }
  const text = `${active.prompt}\n${active.detail}`.trim();
  return {
    visible: true,
    active,
    queued: ordered.length - 1,
    collapsible: isLongForBar(text),
  };
}

/**
 * Длиннее ли текст, чем помещается в свёрнутую полосу.
 *
 * Считаются и переносы строк, и длина: вопрос из четырёх коротких строк так же
 * не помещается, как один длинный абзац.
 *
 * @param text текст вопроса вместе с деталью
 */
export function isLongForBar(text: string): boolean {
  if (!text) return false;
  const lines = text.split("\n");
  if (lines.length > BAR_COLLAPSE_LINES) return true;
  const rendered = lines.reduce(
    (n, line) => n + Math.max(1, Math.ceil(line.length / BAR_CHARS_PER_LINE)),
    0,
  );
  return rendered > BAR_COLLAPSE_LINES;
}

/* ------------------------------------------------------------------ */
/* Где взять активный вопрос                                           */
/* ------------------------------------------------------------------ */

/**
 * Имя инструмента, которым агент задаёт вопрос. Совпадает с `QUESTION_TOOL` в
 * `server/native/agent.mjs`: там по нему ход переводится в
 * `waiting_user_input`, здесь по нему же вопрос попадает в полосу. Разойдись
 * они — сервер считал бы ход ждущим человека, а интерфейс не показывал бы, чего
 * ждут.
 */
export const QUESTION_TOOL = "question";

/** Минимум, который нужен от части сообщения, чтобы узнать в ней вопрос. */
export interface QuestionPartLike {
  type?: unknown;
  tool?: unknown;
  callID?: unknown;
  state?: unknown;
  input?: unknown;
}

export interface MessageLike {
  parts?: unknown;
}

/**
 * Статус вызова инструмента. Форма плавала между версиями движка: раньше
 * строка, с 1.17 — объект `{ status }`.
 */
function partStatus(part: QuestionPartLike): string {
  const s = part.state;
  if (typeof s === "string") return s === "pending" ? "running" : s;
  if (isRecord(s)) {
    const status = typeof s.status === "string" ? s.status : "running";
    return status === "pending" ? "running" : status;
  }
  return "running";
}

function partInput(part: QuestionPartLike): unknown {
  return isRecord(part.state) ? part.state.input : part.input;
}

/**
 * Заберёт ли полоса эту часть сообщения.
 *
 * Предикат существует отдельно и экспортируется, потому что нужен В ДВУХ
 * местах: полоса по нему вопрос берёт, а лента по нему же перестаёт его
 * показывать. Два разных условия здесь дали бы дыру, которую никто не заметит,
 * — лента решила бы, что вопрос ушёл в полосу, полоса его не узнала бы, и ход
 * ждал бы ответа, которого не видно нигде. Одно условие такого состояния не
 * допускает по построению.
 *
 * Условие — `running`. Вопрос со статусом `completed` или `error` ответа уже не
 * ждёт: агент получил результат и пошёл дальше, а полоса с ним висела бы,
 * предлагая ответить на решённое.
 *
 * Имя инструмента бывает объектом-ссылкой во время стрима — тогда часть
 * вопросом НЕ считается. Ошибиться здесь дороже в одну сторону: лишняя полоса
 * перекрывает переписку и требует действия, которого не ждут, а пропущенная
 * оставляет вопрос в ленте, где он и был.
 *
 * @param part часть сообщения
 */
export function isBarQuestionPart(part: unknown): part is QuestionPartLike {
  if (!isRecord(part)) return false;
  if (part.type !== "tool") return false;
  if (part.tool !== QUESTION_TOOL) return false;
  return partStatus(part as QuestionPartLike) === "running";
}

/**
 * Вопрос, оборванный ответом на него самого.
 *
 * Нужен затем, что такая часть остаётся в статусе `error`, а цепочка действий
 * помечает себя красным «error», если ошибочна хоть одна часть. На стенде
 * 01.08.2026 это выглядело так: человек нажал «Вариант 1», получил в ленте
 * красное `Aborted` и рядом «Действия 3 шага error» — два признака поломки
 * подряд там, где ничего не сломалось. Ошибки нет: ход оборван нами и ровно
 * затем, чтобы доставить ответ.
 *
 * Предикат экспортируется, потому что нужен В ДВУХ местах — в шапке цепочки
 * (`MessageItem`) и в шапке группы одинаковых вызовов (`ToolGroup`). Два
 * условия разошлись бы молча, и «error» остался бы висеть в одном из них.
 *
 * Цена решения названа прямо: вопрос, упавший по ДРУГОЙ причине (например,
 * движок не принял нагрузку), тоже перестанет красить цепочку. Отличить одно
 * от другого можно лишь по тексту `output`, а это догадка о чужом формате —
 * ровно то, чего этот проект избегает. Вопрос при этом не исчезает: он виден
 * свёрнутой строкой, и её текст от статуса не зависит.
 *
 * @param part часть сообщения
 */
export function isInterruptedQuestionPart(part: unknown): boolean {
  if (!isRecord(part)) return false;
  if (part.type !== "tool") return false;
  if (part.tool !== QUESTION_TOOL) return false;
  return partStatus(part as QuestionPartLike) === "error";
}

/**
 * Ответ, восстановленный из пользовательской реплики СТАРОЙ истории.
 * До перехода на прямой Question API UI делал abort и отправлял «вопрос:
 * ответ» отдельным user-message. Новые ходы читают metadata.answers tool-call,
 * но этот parser сохраняет корректное отображение уже существующих чатов.
 *
 * Разбор строгий: строка обязана начинаться с текста вопроса. Иначе ответом на
 * вопрос будет объявлена любая следующая реплика пользователя — например
 * «стоп» или новая задача, — и в свёрнутой строке появится выбор, которого
 * никто не делал.
 *
 * @param interruption нормализованный вопрос
 * @param text текст пользовательской реплики целиком
 * @returns выбранные значения либо `null`, если это ответ не на этот вопрос
 */
export function answerFromFeed(
  interruption: Interruption,
  text: string,
): string[] | null {
  const asked = interruption.prompt.trim();
  const body = text.trim();
  if (!body) return null;

  // Пакетный ответ несёт по строке на вопрос — потому ищем строку, а не
  // проверяем начало всего текста.
  let tail = "";
  if (asked) {
    const prefix = `${asked}:`;
    const line = body.split("\n").find((l) => l.trim().startsWith(prefix));
    if (!line) return null;
    tail = line.trim().slice(prefix.length).trim();
  } else {
    // Вопрос без текста: привязать ответ не к чему, и угадывать нельзя.
    if (body.includes("\n")) return null;
    tail = body;
  }
  if (!tail) return null;

  // Несколько выбранных вариантов склеены запятой. Разбирать обратно можно
  // ТОЛЬКО если каждый кусок — надпись варианта: в свободном ответе запятая
  // ничего не разделяет, и «да, но осторожно» распалось бы на два выбора.
  const pieces = tail
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const labels = new Set(interruption.options.map((o) => o.label));
  if (pieces.length > 1 && pieces.every((p) => labels.has(p))) return pieces;
  return [tail];
}

/**
 * Текст реплики, ушедшей ответом на этот вызов инструмента.
 *
 * Сообщение ищется по `callID`, а не по индексу: части перерисовываются на
 * каждом кадре стрима, и позиция вызова в ленте меняется. Дальше берётся
 * ПЕРВАЯ пользовательская реплика после него — ответ уходит сразу за отменой
 * хода, и всё, что стоит дальше, к вопросу отношения не имеет.
 *
 * Извлечение текста передаётся снаружи, потому что оно живёт в `lib/chatText`
 * и тащить его сюда значило бы связать разбор протокола с разметкой ленты.
 *
 * @param messages сообщения чата в порядке появления
 * @param callId идентификатор вызова инструмента
 * @param textOf как достать читаемый текст сообщения
 */
export function replyTextAfterCall<M extends MessageLike>(
  messages: readonly M[],
  callId: string | null,
  textOf: (m: M) => string,
): string {
  if (!callId) return "";
  let found = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const parts = messages[i]?.parts;
    if (!Array.isArray(parts)) continue;
    if (parts.some((p) => isRecord(p) && p.callID === callId)) {
      found = i;
      break;
    }
  }
  if (found < 0) return "";
  for (let i = found + 1; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m) continue;
    const record = m as unknown as Record<string, unknown>;
    const role = isRecord(record.info)
      ? typeof record.info.role === "string"
        ? record.info.role
        : ""
      : "";
    const own = typeof record.role === "string" ? String(record.role) : "";
    if ((own || role) === "user") return textOf(m);
  }
  return "";
}

/**
 * Какой формы должен быть выбор.
 *
 * Форма следует ВИДУ прерывания, а не длине надписей. Первая версия считала по
 * длине, и это было неправильно по существу: она превращала одно и то же
 * действие то в список, то в ряд кнопок в зависимости от того, какие слова
 * подобрала модель. Интерфейс, меняющий форму от содержимого, приходится
 * узнавать заново каждый раз.
 *
 * - `list` — вопрос. Это выбор среди альтернатив: их читают сверху вниз,
 *   сравнивая между собой, и у каждой может быть пояснение. Список во всю
 *   ширину читается одинаково при трёх вариантах и при семи, а ряд кнопок при
 *   длинных надписях переносился по одной и вставал лесенкой у правого края
 *   (снимок со стенда 01.08.2026).
 * - `actions` — разрешение. Это не выбор из равных, а решение с
 *   последствиями: три фиксированных ответа, у которых есть порядок и есть
 *   отказ. Ряд кнопок справа — конвенция диалога, и ломать её ради
 *   единообразия значит менять знакомое на непривычное без выигрыша.
 *
 * @param interruption нормализованное прерывание
 */
export function optionsLayout(interruption: Interruption): "list" | "actions" {
  return interruption.kind === "permission" ? "actions" : "list";
}

/**
 * Вопросы, которые сейчас ждут ответа, и идентификатор их вызова.
 *
 * Часть ищется с конца: вызовов за ход бывает несколько, и ждёт ответа
 * последний. Поиск с начала показывал бы в полосе давно отвеченный.
 *
 * Возвращается ВЕСЬ список вопросов из нагрузки, а не первый. Один вызов
 * инструмента может нести несколько вопросов, и первая версия брала из них
 * только первый — остальные исчезали бы бесследно. Полоса показывает по
 * одному, но число оставшихся при этом видно, а «видно» и «молча пропало» —
 * разные вещи, даже если ответить всё равно удастся только на первый.
 *
 * @param messages сообщения чата в порядке появления
 * @returns прерывания и `callID` для ответа, либо `null`
 */
export function activeQuestion(
  messages: readonly MessageLike[],
): { interruptions: Interruption[]; callId: string | null } | null {
  for (let m = messages.length - 1; m >= 0; m -= 1) {
    const parts = messages[m]?.parts;
    if (!Array.isArray(parts)) continue;
    for (let p = parts.length - 1; p >= 0; p -= 1) {
      const part = parts[p];
      if (!isBarQuestionPart(part)) continue;
      const raw = partInput(part);
      const list =
        isRecord(raw) && Array.isArray(raw.questions) ? raw.questions : [raw];
      const callId = typeof part.callID === "string" ? part.callID : null;
      return {
        interruptions: list.map((q) => normalizeQuestion(q, null)),
        callId,
      };
    }
  }
  return null;
}

/**
 * Строка, которая остаётся в ленте вместо карточки вопроса.
 *
 * Согласовано 31.07.2026: свёрнутая строка «вопрос — ответ», как у прочих
 * вызовов инструментов. Историю переписки надо читать целиком, иначе потом
 * непонятно, почему агент пошёл этим путём; но активный вопрос при этом один и
 * находится в полосе.
 *
 * `null` означает «в ленте показывать нечего»: пока ответа нет, вопрос живёт
 * только в полосе, и вторая его копия рядом была бы двумя местами для одного
 * действия.
 *
 * @param interruption нормализованный вопрос
 * @param answer выбранные значения, если ответ уже дан
 */
export function feedTrace(
  interruption: Interruption,
  answer: readonly string[] | null,
): string | null {
  if (!answer || answer.length === 0) return null;
  const asked = interruption.prompt.trim();
  const given = answer.join(", ");
  return asked ? `${asked} — ${given}` : given;
}

/**
 * Строка истории отвеченного question tool-call.
 *
 * В новом протоколе ответ берётся из `metadata.answers`. `answerFromFeed`
 * существует только для истории старого клиента, который после abort создавал
 * отдельную user-реплику. Если ни одного источника нет, показываем только
 * вопрос и не придумываем подпись «ответ ниже».
 */
export interface FeedLine {
  /** Что написано в свёрнутой строке. */
  text: string;
  /** Приписка справа, тише основного текста. Пустая строка — приписки нет. */
  note: string;
}

/**
 * Что остаётся в ленте от вопроса, на который уже ответили.
 *
 * Если completed question tool содержит metadata.answers, показываем вопрос и
 * ответ одной строкой. Если metadata ещё нет/пришла старая история — показываем
 * только вопрос; отдельного user-message для ответа больше не существует.
 *
 * @param interruption нормализованный вопрос
 * @param answer выбранные значения, если движок сохранил их в части
 */
export function questionFeedLine(
  interruption: Interruption,
  answer: readonly string[] | null,
): FeedLine {
  const trace = feedTrace(interruption, answer);
  if (trace) return { text: trace, note: "" };
  const asked = interruption.prompt.trim();
  return { text: asked || "Вопрос агента", note: "" };
}

/**
 * Есть ли в сообщении вопрос агента — в любом состоянии, а не только ждущий.
 *
 * Нужно там, где по сообщению надо понять ПРИЧИНУ его обрыва: ход, оборванный
 * на вопросе, оборван ответом на этот вопрос, а не отказом модели. Условие
 * `isBarQuestionPart` здесь не годится — оно про «ждёт ответа сейчас», а к
 * моменту показа вопрос уже отвечен.
 *
 * @param message сообщение из ленты
 */
export function hasQuestionPart(message: MessageLike): boolean {
  const parts = message.parts;
  if (!Array.isArray(parts)) return false;
  return parts.some(
    (p) => isRecord(p) && p.type === "tool" && p.tool === QUESTION_TOOL,
  );
}

/**
 * Старый fallback отменял ход и поэтому требовал предупреждения. Теперь ответ
 * либо уходит через Question API в тот же tool-call, либо не отправляется,
 * поэтому предупреждать об abort нечего.
 */
export function replyWarning(_plan: ReplyPlan): string | null {
  return null;
}

/**
 * В корректном Question API ответ не завершает ход и не создаёт отдельную
 * реплику пользователя, поэтому предупреждать об отмене нечего. Пока pending
 * request ещё не появился, кнопка при отправке просто дождётся его несколько
 * коротких попыток и оставит вопрос на месте при неудаче.
 */
export function barWarning(
  _interruption: Interruption,
  _ctx: ReplyContext = {},
): string | null {
  return null;
}
