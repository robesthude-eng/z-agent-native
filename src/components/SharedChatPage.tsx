import { useParams } from "@tanstack/react-router";
import { Wrench } from "lucide-react";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { fetchPublicShare, type PublicSharedChat } from "@/api/client";
import { applyTheme } from "@/config/theme";
import { stripAttachmentMarkup } from "@/lib/attachments";
import { cn } from "@/lib/utils";
import { useStore } from "@/store/useStore";

const remarkPlugins = [remarkGfm, remarkBreaks];
const rehypePlugins = [rehypeSanitize, rehypeHighlight];
const mdComponents = {
  a: ({
    href,
    children,
  }: {
    href?: string | undefined;
    children?: React.ReactNode;
  }) =>
    typeof href === "string" && /^javascript:/i.test(href.trim()) ? (
      <span>{children}</span>
    ) : (
      <a href={href} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    ),
};

type Msg = PublicSharedChat["messages"][number];

function ToolChips({
  tools,
}: {
  tools: Array<{ tool: string; status: string }>;
}) {
  if (!tools.length) return null;
  const counts = new Map<string, { n: number; err: boolean }>();
  for (const t of tools) {
    const c = counts.get(t.tool) ?? { n: 0, err: false };
    c.n += 1;
    c.err ||= t.status === "error";
    counts.set(t.tool, c);
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {[...counts].map(([name, c]) => (
        <span
          key={name}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground",
            c.err && "border-destructive/40",
          )}
        >
          <Wrench size={11} />
          {name}
          {c.n > 1 ? ` ×${c.n}` : ""}
        </span>
      ))}
    </div>
  );
}

function MessageView({ m }: { m: Msg }) {
  const text = stripAttachmentMarkup(
    m.parts
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n\n"),
  ).trim();
  const tools = m.parts.filter((p) => p.type === "tool") as Array<{
    tool: string;
    status: string;
  }>;
  if (m.role === "user") {
    if (!text) return null;
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-muted px-4 py-2.5 text-[15px] leading-relaxed">
          {text}
        </div>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <ToolChips tools={tools} />
      {text && (
        <div className="oc-prose break-words">
          <ReactMarkdown
            remarkPlugins={remarkPlugins}
            rehypePlugins={rehypePlugins}
            components={mdComponents}
          >
            {text}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

/** Публичный просмотр чата по ссылке /share/<token> — без входа и без управления. */
export default function SharedChatPage() {
  const { token } = useParams({ strict: false }) as { token?: string };
  const theme = useStore((s) => s.theme);
  const [chat, setChat] = useState<PublicSharedChat | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    fetchPublicShare(token)
      .then((c) => {
        if (!alive) return;
        setChat(c);
        document.title = `${c.title} · Z Agent`;
      })
      .catch(
        (e) => alive && setError(e instanceof Error ? e.message : String(e)),
      );
    return () => {
      alive = false;
    };
  }, [token]);

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-10 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold">
              {chat?.title ?? "Z Agent"}
            </h1>
            {chat && (
              <div className="text-xs text-muted-foreground">
                Только чтение · обновлён{" "}
                {new Date(chat.updated || chat.created).toLocaleString()}
              </div>
            )}
          </div>
          <span className="shrink-0 rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground">
            Z Agent
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl space-y-6 px-4 py-6">
        {error ? (
          <div className="py-20 text-center text-sm text-muted-foreground">
            {error}
          </div>
        ) : !chat ? (
          <div className="py-20 text-center text-sm text-muted-foreground">
            Загрузка…
          </div>
        ) : chat.messages.length === 0 ? (
          <div className="py-20 text-center text-sm text-muted-foreground">
            В этом чате пока нет сообщений
          </div>
        ) : (
          chat.messages.map((m) => <MessageView key={m.id} m={m} />)
        )}
      </main>
    </div>
  );
}
