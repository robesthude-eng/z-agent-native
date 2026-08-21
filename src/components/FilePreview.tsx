import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { ScrollArea } from "@/components/ui/scroll-area";

export type FilePreviewKind = "image" | "html" | "svg" | "markdown";

// Тот же набор, что в PartView: сначала санитайзер, потом подсветка —
// hljs-классы добавляются после очистки и не вырезаются.
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeSanitize, rehypeHighlight];

/**
 * Просмотр файла воркспейса «как его видит пользователь», а не как текст.
 *
 * HTML грузится через превью-роут сессии, а не через `srcDoc`: страница агента
 * почти всегда ссылается на соседние style.css/script.js, и в `srcDoc`
 * относительные пути некуда резолвить — превью выглядело бы сломанным.
 *
 * iframe без `allow-same-origin`: страница из воркспейса — это чужой код,
 * ей нечего делать в origin приложения (иначе она получила бы доступ к его
 * cookie и DOM).
 */
export default function FilePreview({
  kind,
  path,
  content,
  sessionId,
  url,
}: {
  kind: FilePreviewKind;
  path: string;
  content: string;
  sessionId: string;
  /** URL превью; передаётся вызывающим, чтобы правило сборки жило в одном месте. */
  url: string;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const [imageError, setImageError] = useState(false);

  useEffect(() => {
    setImageError(false);
  }, []);

  if (kind === "markdown") {
    return (
      <ScrollArea className="flex-1 min-h-0 w-full">
        <div className="prose prose-sm max-w-none p-4 text-[13.5px] leading-relaxed [&_a]:text-primary [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_h1]:mb-2 [&_h1]:mt-4 [&_h1]:text-xl [&_h1]:font-bold [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mb-1 [&_h3]:mt-2 [&_h3]:font-semibold [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-6 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-card [&_pre]:p-3 [&_table]:text-[12.5px] [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-6">
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
          >
            {content}
          </ReactMarkdown>
        </div>
      </ScrollArea>
    );
  }

  if (kind === "image" || kind === "svg") {
    // SVG показываем картинкой, а не в iframe: в <img> скрипты внутри SVG
    // не исполняются, а посмотреть нужно именно изображение.
    return (
      <div className="flex flex-1 min-h-0 items-center justify-center overflow-auto bg-[repeating-conic-gradient(#0000_0%_25%,#8883_0%_50%)] bg-[length:16px_16px] p-4">
        {imageError ? (
          <div className="rounded-lg bg-card/95 p-4 text-center text-sm text-muted-foreground shadow">
            <p>Не удалось загрузить изображение.</p>
            <button
              type="button"
              className="mt-2 rounded-md border border-border px-3 py-1.5 hover:bg-accent hover:text-foreground"
              onClick={() => {
                setImageError(false);
                setReloadKey((k) => k + 1);
              }}
            >
              Повторить
            </button>
          </div>
        ) : (
          <img
            key={reloadKey}
            src={url}
            alt={path}
            className="max-h-full max-w-full object-contain"
            onError={() => setImageError(true)}
          />
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-1.5 text-[11px] text-muted-foreground">
        <span className="truncate">
          Живое превью страницы из workspace этого чата
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
            onClick={() => setReloadKey((k) => k + 1)}
          >
            Обновить
          </button>
          <span
            title="Открытие HTML workspace в новой вкладке отключено: это расширяет доверенную границу origin. Используйте встроенное sandbox-превью."
            className="rounded px-1.5 py-0.5 text-muted-foreground"
          >
            В новой вкладке отключено
          </span>
        </div>
      </div>
      <iframe
        key={`${sessionId}:${path}:${reloadKey}`}
        src={url}
        title={`Превью ${path}`}
        className="flex-1 min-h-0 w-full border-none bg-white"
        sandbox="allow-scripts allow-forms"
      />
    </div>
  );
}
