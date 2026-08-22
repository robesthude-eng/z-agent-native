import hljs from "highlight.js/lib/common";
import { useLayoutEffect, useMemo, useRef } from "react";
import { highlightLanguage } from "./codeLanguage";

/**
 * Код файла воркспейса с подсветкой синтаксиса.
 *
 * До этого редактор показывал голый текст: `.json` и `.ts` выглядели
 * одинаково серой стеной, и найти в них строку глазами было тяжелее, чем в
 * любом редакторе кода.
 *
 * Два режима, и разница между ними не косметическая.
 *
 * **Только чтение** — обычный подсвеченный `<pre>`, ничего особенного.
 *
 * **Правка** — подсвеченный `<pre>` ПОД прозрачной `<textarea>`. Подсветить
 * саму textarea нельзя: внутри неё живёт простой текст, разметке там взяться
 * неоткуда. Поэтому текст рисует нижний слой, а верхний остаётся настоящим
 * полем ввода — с курсором, выделением, отменой и системным вводом. Оба слоя
 * обязаны совпадать по метрике до пикселя: любое расхождение в шрифте,
 * межстрочном интервале или отступе разъезжается тем сильнее, чем длиннее
 * файл. Отсюда общий класс `CODE_METRICS` вместо двух похожих наборов.
 *
 * К двум слоям добавился третий — колонка номеров строк. Она живёт по тому
 * же правилу: та же метрика, тот же вертикальный отступ, прокрутка следует за
 * textarea. Номера — `<div>`, а не `<pre>`: второй `<pre>` в дереве сломал бы
 * тесты, которые берут нижний слой через `querySelector("pre")`.
 */

/**
 * Метрика, общая для всех слоёв. Меняется только здесь и только целиком:
 * правка одного слоя рассинхронизирует текст с подсветкой.
 */
const CODE_METRICS =
  "font-mono text-[13px] leading-relaxed whitespace-pre tracking-normal";

/** Ширина колонки номеров. Она же — левый отступ обоих слоёв текста. */
const GUTTER_W = 52;

/** Отступ, тоже общий для обоих слоёв режима правки. */
const CODE_PADDING = `py-4 pr-4 pl-[${GUTTER_W}px]`;

/** Вертикальный отступ колонки номеров совпадает с `CODE_PADDING`. */
const GUTTER_CLASS = `${CODE_METRICS} select-none py-4 pr-3 text-right text-muted-foreground/60`;

/**
 * Потолок подсветки. hljs разбирает весь текст сразу, и на файле в полмегабайта
 * каждое нажатие клавиши вешало бы вкладку на секунды. За потолком файл
 * показывается как текст: читать его можно, править тоже.
 */
const MAX_HIGHLIGHT_CHARS = 500_000;

/**
 * Потолок колонки номеров. Номера — одна строка текста, но на сотнях тысяч
 * строк даже она стоит памяти; такой файл всё равно не читают глазами.
 */
const MAX_GUTTER_LINES = 20_000;

export interface CodeViewProps {
  path: string;
  value: string;
  /** Правка включена — тогда поверх подсветки живёт настоящая textarea. */
  editable: boolean;
  onChange?: (value: string) => void;
  /** Показывается над кодом, когда правка выключена. */
  readonlyNote?: string;
}

export default function CodeView({
  path,
  value,
  editable,
  onChange,
  readonlyNote,
}: CodeViewProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  const language = highlightLanguage(path, value);

  // Разметка подсветки. hljs экранирует исходный текст сам — то, что придёт
  // из файла, не может стать разметкой. Пересчёт привязан к тексту и языку:
  // на каждый ввод символа это один проход по видимому файлу.
  const html = useMemo(() => {
    if (!language) return null;
    if (value.length > MAX_HIGHLIGHT_CHARS) return null;
    try {
      return hljs.highlight(value, { language, ignoreIllegals: true }).value;
    } catch {
      // Незнакомый язык или сломанная грамматика — показываем как текст.
      return null;
    }
  }, [value, language]);

  // Номера строк. Считаются по тому же тексту, что видит textarea, иначе
  // последняя строка осталась бы без номера.
  const gutter = useMemo(() => {
    const lines = value.split("\n").length;
    if (lines > MAX_GUTTER_LINES) return null;
    let out = "";
    for (let i = 1; i <= lines; i++) out += `${i}\n`;
    return out;
  }, [value]);

  // Прокрутка нижних слоёв следует за верхним. useLayoutEffect, а не
  // useEffect: после смены текста позицию нужно вернуть до кадра, иначе
  // подсветка на мгновение съезжает.
  useLayoutEffect(() => {
    const ta = taRef.current;
    const pre = preRef.current;
    if (!ta || !pre) return;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  }, []);

  const syncScroll = () => {
    const ta = taRef.current;
    const pre = preRef.current;
    if (!ta || !pre) return;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
    if (gutterRef.current) gutterRef.current.scrollTop = ta.scrollTop;
  };

  // Разметку создаёт highlight.js из текста, который он же и экранировал:
  // содержимое файла не может стать тегами. Тот же приём и та же гарантия,
  // что у rehype-highlight в PartView и FilePreview.
  //
  // Перевод строки в конце — не украшение, а выравнивание слоёв. Textarea
  // держит место под строку после последнего `\n`, а `<pre>` её схлопывает,
  // и высоты расходятся ровно на одну строку. Пока файл влезает в окно, это
  // не видно; в самом низу длинного файла нижний слой упирается в свой
  // предел на 21 пиксель раньше, и подсветка последней строки съезжает.
  // Замерено: scrollHeight 8006 против 7985 на файле в 400 строк.
  const code = html ? (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: см. комментарий выше — источник разметки контролируется hljs, вход экранирован
    <code dangerouslySetInnerHTML={{ __html: `${html}\n` }} />
  ) : (
    <code>{`${value}\n`}</code>
  );

  if (!editable) {
    return (
      <>
        {readonlyNote && (
          <div className="shrink-0 border-b border-border bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground">
            {readonlyNote}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-auto">
          <div className="flex min-w-max">
            {gutter && (
              // sticky, а не просто колонка: при горизонтальной прокрутке
              // длинной строки номера должны оставаться на месте.
              <div
                aria-hidden="true"
                className={`${GUTTER_CLASS} sticky left-0 z-10 shrink-0 border-r border-border/60 bg-card`}
                style={{ width: GUTTER_W }}
              >
                {gutter}
              </div>
            )}
            <pre className={`${CODE_METRICS} py-4 pr-4 pl-3 text-foreground`}>
              {code}
            </pre>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
      {gutter && (
        <div
          ref={gutterRef}
          aria-hidden="true"
          className={`${GUTTER_CLASS} pointer-events-none absolute inset-y-0 left-0 z-10 overflow-hidden border-r border-border/60 bg-card`}
          style={{ width: GUTTER_W }}
        >
          {gutter}
        </div>
      )}
      <pre
        ref={preRef}
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 overflow-hidden ${CODE_METRICS} ${CODE_PADDING} text-foreground`}
      >
        {code}
      </pre>
      <textarea
        ref={taRef}
        // Текст прозрачный — его рисует слой ниже. Курсор остаётся видимым:
        // без `caret-color` он унаследовал бы прозрачность, и печатать
        // пришлось бы вслепую.
        className={`absolute inset-0 h-full w-full resize-none bg-transparent text-transparent caret-foreground outline-none ${CODE_METRICS} ${CODE_PADDING}`}
        spellCheck={false}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        onScroll={syncScroll}
      />
    </div>
  );
}
