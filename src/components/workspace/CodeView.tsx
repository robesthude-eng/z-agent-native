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
 */

/**
 * Метрика, общая для обоих слоёв. Меняется только здесь и только целиком:
 * правка одного слоя рассинхронизирует текст с подсветкой.
 */
const CODE_METRICS =
  "font-mono text-[13px] leading-relaxed whitespace-pre tracking-normal";

/** Отступ, тоже общий для обоих слоёв. */
const CODE_PADDING = "p-4";

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

  const language = highlightLanguage(path, value);

  // Разметка подсветки. hljs экранирует исходный текст сам — то, что придёт
  // из файла, не может стать разметкой. Пересчёт привязан к тексту и языку:
  // на каждый ввод символа это один проход по видимому файлу.
  const html = useMemo(() => {
    if (!language) return null;
    try {
      return hljs.highlight(value, { language, ignoreIllegals: true }).value;
    } catch {
      // Незнакомый язык или сломанная грамматика — показываем как текст.
      return null;
    }
  }, [value, language]);

  // Прокрутка нижнего слоя следует за верхним. useLayoutEffect, а не
  // useEffect: после смены текста позицию нужно вернуть до кадра, иначе
  // подсветка на мгновение съезжает.
  useLayoutEffect(() => {
    const ta = taRef.current;
    const pre = preRef.current;
    if (!ta || !pre) return;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  }, []);

  const syncScroll = () => {
    const ta = taRef.current;
    const pre = preRef.current;
    if (!ta || !pre) return;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
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
          <pre className={`${CODE_METRICS} ${CODE_PADDING} text-foreground`}>
            {code}
          </pre>
        </div>
      </>
    );
  }

  return (
    <div className="relative min-h-0 flex-1">
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
