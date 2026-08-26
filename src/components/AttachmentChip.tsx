import {
  Download,
  Eye,
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
 * отрисовка.
 */

interface ExtensionStyle {
  label: string;
  color: string;
  bgColor: string;
  borderColor: string;
}

export function getFileExtensionBadge(filename: string): ExtensionStyle {
  const ext = filename.split(".").pop()?.toLowerCase() || "";
  switch (ext) {
    case "ts":
      return {
        label: "TS",
        color: "text-blue-400",
        bgColor: "bg-blue-500/10",
        borderColor: "border-blue-500/30",
      };
    case "tsx":
      return {
        label: "TSX",
        color: "text-blue-400",
        bgColor: "bg-blue-500/15",
        borderColor: "border-blue-500/40",
      };
    case "js":
      return {
        label: "JS",
        color: "text-amber-400",
        bgColor: "bg-amber-500/10",
        borderColor: "border-amber-500/30",
      };
    case "jsx":
      return {
        label: "JSX",
        color: "text-amber-400",
        bgColor: "bg-amber-500/15",
        borderColor: "border-amber-500/40",
      };
    case "py":
      return {
        label: "PY",
        color: "text-emerald-400",
        bgColor: "bg-emerald-500/15",
        borderColor: "border-emerald-500/30",
      };
    case "json":
      return {
        label: "JSON",
        color: "text-amber-300",
        bgColor: "bg-amber-500/15",
        borderColor: "border-amber-500/30",
      };
    case "css":
    case "scss":
    case "sass":
    case "less":
      return {
        label: "CSS",
        color: "text-cyan-400",
        bgColor: "bg-cyan-500/15",
        borderColor: "border-cyan-500/30",
      };
    case "html":
    case "htm":
      return {
        label: "HTML",
        color: "text-orange-400",
        bgColor: "bg-orange-500/15",
        borderColor: "border-orange-500/30",
      };
    case "md":
    case "markdown":
      return {
        label: "MD",
        color: "text-purple-400",
        bgColor: "bg-purple-500/15",
        borderColor: "border-purple-500/30",
      };
    case "sh":
    case "bash":
    case "zsh":
      return {
        label: "SH",
        color: "text-green-400",
        bgColor: "bg-green-500/15",
        borderColor: "border-green-500/30",
      };
    case "sql":
      return {
        label: "SQL",
        color: "text-indigo-400",
        bgColor: "bg-indigo-500/15",
        borderColor: "border-indigo-500/30",
      };
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "svg":
    case "webp":
      return {
        label: "IMG",
        color: "text-violet-400",
        bgColor: "bg-violet-500/15",
        borderColor: "border-violet-500/30",
      };
    case "zip":
    case "tar":
    case "gz":
      return {
        label: "ZIP",
        color: "text-yellow-400",
        bgColor: "bg-yellow-500/15",
        borderColor: "border-yellow-500/30",
      };
    case "pdf":
      return {
        label: "PDF",
        color: "text-rose-400",
        bgColor: "bg-rose-500/15",
        borderColor: "border-rose-500/30",
      };
    case "yaml":
    case "yml":
      return {
        label: "YML",
        color: "text-red-400",
        bgColor: "bg-red-500/15",
        borderColor: "border-red-500/30",
      };
    case "rs":
      return {
        label: "RS",
        color: "text-orange-400",
        bgColor: "bg-orange-500/15",
        borderColor: "border-orange-500/30",
      };
    case "go":
      return {
        label: "GO",
        color: "text-sky-400",
        bgColor: "bg-sky-500/15",
        borderColor: "border-sky-500/30",
      };
    default:
      return {
        label: ext ? ext.toUpperCase().slice(0, 4) : "FILE",
        color: "text-muted-foreground",
        bgColor: "bg-muted/60",
        borderColor: "border-border",
      };
  }
}

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
    "group/att flex max-w-full items-center justify-between gap-2.5 rounded-xl border border-border/80 bg-card/90 px-3 py-2 text-sm not-prose shadow-sm transition hover:border-primary/40 hover:bg-accent/30";
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
      <div className="flex min-w-0 flex-1 items-center gap-2.5">{children}</div>
      <Download className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition group-hover/att:text-primary" />
    </a>
  );
}

/**
 * Универсальный чип файла, который уже лежит в workspace сессии.
 *
 * Основное действие — открыть файл в панели Files в один клик.
 */
export function WorkspaceFileChip({
  name,
  path,
  meta,
}: {
  name: string;
  path: string;
  meta?: string | undefined;
}) {
  const currentID = useStore((s) => s.currentID);
  const requestOpenFile = useStore((s) => s.requestOpenFile);
  const isZip = /\.zip\b/i.test(name);
  const isImage = /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
  const relPath = path ? toWorkspaceRelPath(path) : null;
  const href =
    path && currentID ? workspaceDownloadUrl(path, currentID) : undefined;
  const openable = !!relPath && !!currentID && !isZip;
  const badge = getFileExtensionBadge(name);

  const dirPath =
    relPath && relPath !== name && relPath.includes("/")
      ? relPath.slice(0, relPath.lastIndexOf("/"))
      : "";

  const iconBlock = (
    <span
      className={cn(
        "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border font-mono text-[10px] font-bold tracking-tight",
        badge.bgColor,
        badge.color,
        badge.borderColor,
      )}
    >
      {isImage ? (
        <ImageIcon className="h-4 w-4" />
      ) : isZip ? (
        <FileArchive className="h-4 w-4" />
      ) : (
        badge.label
      )}
    </span>
  );

  const textBlock = (
    <div className="min-w-0 flex-1 text-left">
      <div className="truncate font-medium text-foreground transition-colors group-hover/att:text-primary">
        {name}
      </div>
      <div className="flex items-center gap-1.5 truncate text-[11px] text-muted-foreground">
        {dirPath ? (
          <span className="truncate opacity-75">{dirPath}/</span>
        ) : meta ? (
          <span className="truncate">{meta}</span>
        ) : (
          <span>{t("attachment_chip.fayl_v_workspace")}</span>
        )}
      </div>
    </div>
  );

  if (!openable)
    return (
      <ChipShell href={href} name={name}>
        {iconBlock}
        {textBlock}
      </ChipShell>
    );

  return (
    <div className="group/att flex max-w-full items-center justify-between gap-2.5 rounded-xl border border-border/80 bg-card/90 px-3 py-2 text-sm not-prose shadow-sm transition hover:border-primary/50 hover:bg-accent/40 hover:shadow-md">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left focus:outline-none"
        onClick={() => {
          if (relPath) requestOpenFile(relPath);
        }}
        title={tf("attachment_chip.otkryt_0_v_paneli_faylov", [
          relPath || name,
        ])}
      >
        {iconBlock}
        {textBlock}
      </button>

      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => {
            if (relPath) requestOpenFile(relPath);
          }}
          className="inline-flex items-center gap-1 rounded-lg bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary transition hover:bg-primary/20 active:scale-95"
          title={tf("attachment_chip.otkryt_0_v_paneli_faylov", [
            relPath || name,
          ])}
        >
          <Eye className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Открыть</span>
        </button>

        {href && (
          <a
            href={href}
            download={name}
            title={tf("attachment_chip.skachat_0", [name])}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground/60 transition hover:bg-muted hover:text-foreground active:scale-95"
          >
            <Download className="h-3.5 w-3.5" />
          </a>
        )}
      </div>
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
          className="h-9 w-9 shrink-0 rounded-lg object-cover"
        />
      ) : (
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
          {icon}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{name}</div>
        <div className="text-[11px] text-muted-foreground">
          {formatSize(att.size || 0)}
        </div>
      </div>
    </ChipShell>
  );
}
