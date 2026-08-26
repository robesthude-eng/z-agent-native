import {
  Download,
  FileArchive,
  FileText,
  Image as ImageIcon,
  Paperclip,
} from "lucide-react";
import type { ReactNode } from "react";
import { t, tf } from "@/i18n";
import { cn } from "@/lib/utils";
import { workspaceDownloadUrl } from "../api/client";
import { formatSize } from "../api/files";
import type { AttachmentRef } from "../lib/attachments";
import { toWorkspaceRelPath } from "../lib/workspacePath";
import { useStore } from "../store/useStore";

/**
 * Разбор формата вложений живёт в src/lib/attachments.ts — здесь только
 * отрисовка. Раньше регулярка и вычленение строк были прямо в этом файле,
 * из-за чего «как выглядит вложение» и «как оно закодировано» правились
 * в разных местах и разъезжались.
 */

const KIND_ICONS: Record<string, ReactNode> = {
  image: <ImageIcon className="h-4 w-4" />,
  pdf: <FileText className="h-4 w-4" />,
  text: <FileText className="h-4 w-4" />,
  zip: <FileArchive className="h-4 w-4" />,
  binary: <Paperclip className="h-4 w-4" />,
};

/** Оболочка чипа: ссылка-скачивание, если есть href, иначе обычный div. */
function ChipShell({
  href,
  name,
  children,
}: {
  href?: string | undefined;
  name: string;
  children: ReactNode;
}) {
  const cls =
    "group/att flex max-w-full items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-2 text-sm not-prose";
  if (!href) return <div className={cls}>{children}</div>;
  return (
    <a
      href={href}
      download={name}
      title={tf("attachment_chip.skachat_0", [name])}
      className={cn(
        cls,
        "cursor-pointer no-underline transition hover:border-primary/40 hover:bg-accent/30",
      )}
    >
      {children}
      <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition group-hover/att:text-primary" />
    </a>
  );
}

/**
 * Универсальный чип файла, который уже лежит в workspace сессии.
 *
 * Основное действие — открыть файл в панели Files (агент только что его
 * создал, и первое желание — посмотреть содержимое, а не скачать). Скачивание
 * осталось отдельной иконкой: кнопку нельзя вложить в ссылку, поэтому чип —
 * это кнопка, а рядом — ссылка-скачивание.
 */
export function WorkspaceFileChip({
  name,
  path,
  meta = t("attachment_chip.fayl_v_workspace"),
}: {
  name: string;
  path: string;
  meta?: string;
}) {
  const currentID = useStore((s) => s.currentID);
  const requestOpenFile = useStore((s) => s.requestOpenFile);
  const isZip = /\.zip\b/i.test(name);
  const relPath = path ? toWorkspaceRelPath(path) : null;
  const href =
    path && currentID ? workspaceDownloadUrl(path, currentID) : undefined;
  // Zip открывать в текстовом редакторе бессмысленно — для него оставляем
  // только скачивание.
  const openable = !!relPath && !!currentID && !isZip;

  const body = (
    <>
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground">
        {isZip ? (
          <FileArchive className="h-4 w-4" />
        ) : (
          <Paperclip className="h-4 w-4" />
        )}
      </span>
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate font-medium">{name}</div>
        {meta && (
          <div className="truncate text-xs text-muted-foreground">{meta}</div>
        )}
      </div>
    </>
  );

  if (!openable)
    return (
      <ChipShell href={href} name={name}>
        {body}
      </ChipShell>
    );

  return (
    <div className="group/att flex max-w-full items-center gap-1 rounded-lg border border-border bg-card pr-1.5 text-sm not-prose transition hover:border-primary/40 hover:bg-accent/30">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-2 text-left"
        onClick={() => {
          if (relPath) requestOpenFile(relPath);
        }}
        title={tf("attachment_chip.otkryt_0_v_paneli_faylov", [relPath])}
      >
        {body}
      </button>
      {href && (
        <a
          href={href}
          download={name}
          title={tf("attachment_chip.skachat_0", [name])}
          className="shrink-0 rounded p-1 text-muted-foreground/50 no-underline transition hover:text-primary"
        >
          <Download className="h-3.5 w-3.5" />
        </a>
      )}
    </div>
  );
}

/** Чип по разобранной ссылке на файл (см. src/lib/attachments.ts). */
export function AttachmentChip({ file }: { file: AttachmentRef }) {
  const meta =
    [file.note, typeof file.size === "number" ? formatSize(file.size) : ""]
      .filter(Boolean)
      .join(" · ") || file.path;
  return <WorkspaceFileChip name={file.name} path={file.path} meta={meta} />;
}

/** Чип для attachment-части сообщения (вложения из Composer). */
export function AttachmentPartChip({
  att,
}: {
  att: {
    name?: string;
    size?: number;
    kind?: string;
    path?: string;
    dataUrl?: string;
  };
}) {
  const currentID = useStore((s) => s.currentID);
  const name = att.name || "file";
  const icon = KIND_ICONS[att.kind || ""] || <Paperclip className="h-4 w-4" />;
  const href =
    att.path && currentID
      ? workspaceDownloadUrl(att.path, currentID)
      : undefined;
  const workspacePreview =
    att.kind === "image" && att.path && currentID
      ? `/api/sandbox-proxy/${encodeURIComponent(currentID)}/~/${att.path
          .split("/")
          .map(encodeURIComponent)
          .join("/")}`
      : undefined;
  const imageSrc = att.dataUrl || workspacePreview;
  return (
    <ChipShell href={href} name={name}>
      {att.kind === "image" && imageSrc ? (
        <img
          src={imageSrc}
          alt={name}
          className="h-10 w-10 shrink-0 rounded-lg object-cover"
        />
      ) : (
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/50 text-muted-foreground">
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{name}</div>
        <div className="text-xs text-muted-foreground">
          {formatSize(att.size || 0)}
        </div>
      </div>
    </ChipShell>
  );
}
