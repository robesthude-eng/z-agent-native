import { ChevronRight, FileText } from "lucide-react";
import React, {
  type ComponentPropsWithoutRef,
  memo,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { publicErrorText } from "../api/eventGuards";
import { isVisible, presentationFor } from "../api/partPresentation";
import type { Part, ToolPart } from "../api/types";
import { extractAttachments } from "../lib/attachments";
import { useSmoothStreamingText } from "../lib/useSmoothText";
import {
  looksLikeWorkspacePath,
  toWorkspaceRelPath,
} from "../lib/workspacePath";
import { useStore } from "../store/useStore";
import { AttachmentChip, AttachmentPartChip } from "./AttachmentChip";
import CopyButton from "./CopyButton";
import { ThinkIcon } from "./icons";
import ToolCard from "./ToolCard";

/** Рекурсивно собирает текст из React-узлов (подсвеченный код и т.п.). */
function nodeToText(node: unknown): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(nodeToText).join("");
  if (typeof node === "object" && "props" in node) {
    const el = node as { props?: { children?: unknown } };
    return nodeToText(el.props?.children);
  }
  return "";
}

const SAFE_MD_COMPONENTS = {
  a: ({ href, children }: { href?: string; children?: ReactNode }) => {
    if (typeof href === "string" && /^javascript:/i.test(href.trim())) {
      return <span>{children as ReactNode}</span>;
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children as ReactNode}
      </a>
    );
  },
  pre: ({
    children,
    ...props
  }: ComponentPropsWithoutRef<"pre"> & { children?: ReactNode }) => {
    let codeText = "";
    let language = "plaintext";
    try {
      const child = React.Children.only(children) as React.ReactElement<{
        className?: string;
        children?: string | string[];
      }>;
      const className = child?.props?.className || "";
      const match = className.match(/language-(\w+)/);
      if (match) {
        language = match[1] ?? "plaintext";
      }
      if (child?.props) {
        codeText = nodeToText(child.props.children);
      }
    } catch {
      // fallback
    }
    return (
      <div className="group/code relative my-3 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between bg-muted/50 px-3 py-1.5 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">
              <FileText className="h-3.5 w-3.5" />
            </span>
            <span className="text-[11px] font-mono text-muted-foreground truncate max-w-[200px]">
              {language}_block
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground/60 px-1.5 py-0.5 rounded bg-background/50 border border-border">
              {language}
            </span>
            <CopyButton
              text={codeText || nodeToText(children)}
              title="Копировать код"
              className="h-6 w-6"
            />
          </div>
        </div>
        <pre
          className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed text-foreground/90 bg-background/40"
          {...props}
        >
          {children}
        </pre>
      </div>
    );
  },
  code: ({
    className,
    children,
    ...props
  }: ComponentPropsWithoutRef<"code">) => {
    const isBlock =
      typeof className === "string" && className.includes("language-");
    if (isBlock) {
      return (
        <code className={cn("font-mono text-[13px]", className)} {...props}>
          {children}
        </code>
      );
    }
    return <InlineCode {...props}>{children}</InlineCode>;
  },
} as Components;

/**
 * Инлайн-код в ответе агента. Если это путь к файлу — делаем его кнопкой,
 * открывающей файл в панели Files: раньше упомянутый `src/app.tsx` был просто
 * текстом, и путь приходилось искать в дереве руками.
 */
function InlineCode({ children, ...props }: ComponentPropsWithoutRef<"code">) {
  const requestOpenFile = useStore((s) => s.requestOpenFile);
  const hasSession = useStore((s) => !!s.currentID);
  const raw = nodeToText(children);
  const relPath =
    hasSession && looksLikeWorkspacePath(raw) ? toWorkspaceRelPath(raw) : null;

  if (!relPath) {
    return (
      <code
        className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-foreground"
        {...props}
      >
        {children}
      </code>
    );
  }
  return (
    <button
      type="button"
      title={`Открыть ${relPath} в панели файлов`}
      onClick={() => requestOpenFile(relPath)}
      className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.9em] text-foreground underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 transition hover:bg-accent hover:text-primary"
    >
      {children}
    </button>
  );
}

// "stub" — synthetic placeholder created by patchPartDelta when a delta
// arrives before its part; hidden until the real part type arrives.
// "file" больше НЕ скрывается: вложения рендерятся как файл-чипы.
// Этап 3.2: решение «каким видом показывается часть» вынесено в
// `src/api/partPresentation.ts` и проверяется там перебором. Здесь остаётся
// разметка. Прежние множества `HIDDEN_TYPES` и `STEP_TYPES` жили тут же и
// вместе со `switch` составляли три разных способа решить один вопрос —
// увидеть их мог только рендер.

const asText = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "object") {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
};

const markdownPlugins = [remarkGfm, remarkBreaks];
// P0-fix (XSS): rehype-sanitize вырезает опасные теги/атрибуты по
// GitHub-схеме по умолчанию (сохраняя className="language-*" у code).
// Порядок важен: сначала санитайзер, затем rehypeHighlight — его
// hljs-классы добавляются после очистки и не страдают.
const rehypePlugins = [rehypeSanitize, rehypeHighlight];

// Релиз 3: лимит размера ответа для рендера. Markdown-рендер сообщений
// в сотни килобайт (логи, дампы) замораживает вкладку; усечённый текст
// с кнопкой «Показать полностью» держит интерфейс отзывчивым.
const RENDER_TEXT_LIMIT = 30_000;

// Релиз 4: плавный стрим. Раньше стоял дебаунс 150мс — текст прыгал
// крупными кусками. Теперь «догоняющий» typewriter из useSmoothText
// даёт визуально непрерывный вывод без потери производительности
// (обновления ~30fps, длинные тексты применяются сразу).

const LimitedMarkdown = ({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean | undefined;
}) => {
  const [showAll, setShowAll] = useState(false);
  const truncated = !showAll && text.length > RENDER_TEXT_LIMIT;
  const visible = truncated ? text.slice(0, RENDER_TEXT_LIMIT) : text;
  // Плавный «догоняющий» вывод текста во время стрима.
  const displayText = useSmoothStreamingText(visible, !!streaming);
  return (
    <>
      <ReactMarkdown
        remarkPlugins={markdownPlugins}
        rehypePlugins={rehypePlugins}
        components={SAFE_MD_COMPONENTS}
      >
        {displayText}
      </ReactMarkdown>
      {streaming && !truncated && <span className="streaming-cursor" />}
      {truncated && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-accent/40 transition"
        >
          Показать полностью (ещё{" "}
          {(text.length - RENDER_TEXT_LIMIT).toLocaleString("ru-RU")} символов)
        </button>
      )}
    </>
  );
};

function formatRussianSeconds(secs: number): string {
  if (secs === 1) return "1 секунду";
  const mod100 = secs % 100;
  const mod10 = secs % 10;
  if (mod100 >= 11 && mod100 <= 19) return `${secs} секунд`;
  if (mod10 === 1) return `${secs} секунду`;
  if (mod10 >= 2 && mod10 <= 4) return `${secs} секунды`;
  return `${secs} секунд`;
}

function useThinkingDuration(streaming?: boolean): string {
  const [startedAt] = useState(() => Date.now());
  const frozenEndRef = useRef<number | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (streaming) {
      frozenEndRef.current = null;
      const id = setInterval(() => setTick((t) => t + 1), 500);
      return () => clearInterval(id);
    }
    if (frozenEndRef.current === null) {
      frozenEndRef.current = Date.now();
    }
  }, [streaming]);

  const end =
    streaming || frozenEndRef.current === null
      ? Date.now()
      : frozenEndRef.current;
  const secs = Math.max(0, Math.round((end - startedAt) / 1000));
  return formatRussianSeconds(secs);
}

function ReasoningCard({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean | undefined;
}) {
  const [manuallyToggled, setManuallyToggled] = useState<boolean | null>(null);
  const expanded = manuallyToggled ?? !!streaming;
  const duration = useThinkingDuration(streaming);
  // Плавный вывод стримящегося reasoning-текста.
  const displayText = useSmoothStreamingText(text, !!streaming);

  return (
    <div className="not-prose my-1">
      {/* Ghost-строка заголовка reasoning */}
      <button
        type="button"
        className="group/reason flex w-full items-center gap-2 px-2 py-1.5 text-left rounded-lg hover:bg-accent/30 transition cursor-pointer"
        // Один клик переключает относительно видимого состояния (фикс двойного клика).
        onClick={() => setManuallyToggled(!expanded)}
      >
        <span
          className={cn(
            "flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground",
            streaming && "animate-pulse text-foreground",
          )}
        >
          <ThinkIcon size={15} />
        </span>
        <span className="text-[13px] font-medium text-foreground/85">
          {streaming ? "Размышляет" : "Думал"}
        </span>
        {streaming && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400 animate-pulse" />
        )}
        {!streaming && duration && (
          <span className="text-[11.5px] text-muted-foreground/70">
            {duration}
          </span>
        )}
        <span className="flex-1" />
        <span className="text-muted-foreground/50 shrink-0">
          <ChevronRight
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              expanded && "rotate-90",
            )}
          />
        </span>
      </button>
      {/* Раскрытый reasoning-текст */}
      {expanded && (
        <div
          className="oc-card-open mt-1.5 ml-6 rounded-lg border border-border px-3 py-2 text-[12.5px] leading-relaxed text-muted-foreground/90 prose prose-sm max-w-none prose-p:my-1.5 [&_*]:text-muted-foreground/90"
          style={{
            background: "color-mix(in srgb, var(--color-card) 100%, white 4%)",
          }}
        >
          <ReactMarkdown
            remarkPlugins={markdownPlugins}
            rehypePlugins={rehypePlugins}
            components={SAFE_MD_COMPONENTS}
          >
            {displayText}
          </ReactMarkdown>
          {streaming && <span className="streaming-cursor" />}
        </div>
      )}
    </div>
  );
}

const OptimizedPartView = ({
  part,
  isLastStreaming,
}: {
  part: Part;
  isLastStreaming?: boolean;
}) => {
  if (!part || typeof part !== "object") return null;
  const p = part as { type?: string; text?: unknown };
  const presentation = presentationFor(part);
  if (!isVisible(presentation)) return null;

  const renderMarkdown = (text: string) => (
    <ReactMarkdown
      remarkPlugins={markdownPlugins}
      rehypePlugins={rehypePlugins}
      components={SAFE_MD_COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  );

  if (presentation === "step") {
    const t = asText(p.text);
    return (
      <div className="text-sm text-muted-foreground opacity-80">
        {renderMarkdown(t)}
        {isLastStreaming && <span className="streaming-cursor" />}
      </div>
    );
  }

  switch (p.type) {
    case "attachment": {
      const att = part as {
        type: string;
        name?: string;
        size?: number;
        kind?: string;
        path?: string;
        dataUrl?: string;
      };
      // Кликабельный файл-чип: скачивание через /api/workspace/download.
      return <AttachmentPartChip att={att} />;
    }
    case "file": {
      // Полноценный file-part (data URL или file://) — рендерим общим чипом.
      // Раньше здесь была отдельная вёрстка БЕЗ ссылки на скачивание: после
      // перезагрузки страницы (сервер отдаёт вложения именно file-частями)
      // файл в сообщении превращался в мёртвую карточку, которую нельзя ни
      // открыть, ни скачать — в отличие от свежеотправленного.
      const f = part as {
        type: string;
        filename?: string;
        mime?: string;
        url?: string;
      };
      const mime = f.mime || "";
      const url = f.url || "";
      const isDataUrl = url.startsWith("data:");
      const fileKind = mime.startsWith("image/")
        ? "image"
        : mime === "application/pdf"
          ? "pdf"
          : mime.startsWith("text/")
            ? "text"
            : mime.includes("zip")
              ? "zip"
              : "binary";
      return (
        <AttachmentPartChip
          att={{
            name: f.filename || "file",
            kind: fileKind,
            // data: — превью прямо из сообщения; file:// — путь в workspace,
            // из которого чип соберёт ссылку /api/workspace/download.
            ...(isDataUrl ? { dataUrl: url } : {}),
            ...(url && !isDataUrl ? { path: url } : {}),
          }}
        />
      );
    }
    case "text": {
      if (!p.text) return null;
      const txt = publicErrorText(asText(p.text));
      // Если это старое или текущее вложенное текстовое сообщение формата «📄 filename\n```...```»,
      // превращаем «📄 filename\n```...```» в «📎 filename → uploads/filename», чтобы отрендерить чипом!
      const normalizedTxt = txt.replace(
        /^📄 ([^\n]+?)\n```[\s\S]*?```/gm,
        "📎 $1 → uploads/$1",
      );
      // Разбор обоих форматов ссылок на файлы — в src/lib/attachments.ts.
      const { refs: attRefs, rest: restText } =
        extractAttachments(normalizedTxt);
      return (
        <>
          {attRefs.length > 0 && (
            <div className="my-1 flex flex-wrap gap-2">
              {/* Путь — устойчивая идентичность файла: индекс сдвигается,
                  когда агент дописывает текст выше. */}
              {attRefs.map((r) => (
                <AttachmentChip key={r.path || r.name} file={r} />
              ))}
            </div>
          )}
          {restText && (
            <div className="break-words text-[14.5px] leading-relaxed [&_p]:my-2 [&_pre]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-2 [&_li]:my-1 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:my-4 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:my-3 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:my-2 [&_h4]:text-base [&_h4]:font-semibold [&_h4]:my-2 [&_strong]:font-semibold [&_a]:text-primary [&_a]:underline">
              <LimitedMarkdown text={restText} streaming={isLastStreaming} />
            </div>
          )}
        </>
      );
    }
    case "reasoning":
      if (!p.text) return null;
      return (
        <ReasoningCard text={asText(p.text)} streaming={isLastStreaming} />
      );
    case "tool":
      return <ToolCard part={part as ToolPart} />;
    default:
      if (!p.text) return null;
      return (
        <div className="break-words text-[14.5px] leading-relaxed [&_p]:my-2 [&_pre]:my-2 [&_ul]:list-disc [&_ul]:pl-6 [&_ul]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_ol]:my-2 [&_li]:my-1 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:my-4 [&_h2]:text-xl [&_h2]:font-bold [&_h2]:my-3 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:my-2 [&_h4]:text-base [&_h4]:font-semibold [&_h4]:my-2 [&_strong]:font-semibold [&_a]:text-primary [&_a]:underline">
          <LimitedMarkdown text={asText(p.text)} streaming={isLastStreaming} />
        </div>
      );
  }
};

export default memo(OptimizedPartView);
