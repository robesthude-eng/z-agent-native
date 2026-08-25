import {
  FileArchive as FileArchiveIcon,
  FileText as FileTextIcon,
  Image as ImageIcon,
} from "lucide-react";
import type { ProcessedFile } from "@/api/files";
import { formatSize } from "@/api/files";
import { tf } from "@/i18n";
import { CloseIcon, PaperclipIcon } from "../icons";

interface ComposerAttachmentsProps {
  attachments: ProcessedFile[];
  uploadProgress: Record<string, number>;
  sessionId: string | null;
  onRemove: (name: string) => void;
}

function attachmentIcon(kind: string) {
  if (kind === "image") return <ImageIcon size={15} />;
  if (kind === "zip") return <FileArchiveIcon size={15} />;
  if (kind === "pdf" || kind === "text") return <FileTextIcon size={15} />;
  return <PaperclipIcon size={15} />;
}

export function ComposerAttachments({
  attachments,
  uploadProgress,
  sessionId,
  onRemove,
}: ComposerAttachmentsProps) {
  if (attachments.length === 0 && Object.keys(uploadProgress).length === 0) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2 px-2 pb-2">
      {attachments.map((attachment) => (
        <div
          key={attachment.name}
          className="group/chip flex max-w-[240px] items-center gap-2 rounded-lg border border-border bg-muted/40 py-1.5 pl-1.5 pr-1 text-xs"
        >
          {attachment.kind === "image" &&
          attachment.workspacePath &&
          sessionId ? (
            <img
              src={`/api/sandbox-proxy/${encodeURIComponent(sessionId)}/~/${attachment.workspacePath
                .split("/")
                .map(encodeURIComponent)
                .join("/")}`}
              alt={attachment.name}
              className="h-8 w-8 shrink-0 rounded-md object-cover"
            />
          ) : (
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background/70 text-muted-foreground">
              {attachmentIcon(attachment.kind)}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-foreground">
              {attachment.name}
            </div>
            <div className="text-[11px] text-muted-foreground">
              {formatSize(attachment.size)}
              {typeof attachment.entryCount === "number" &&
                tf("composer.0_faylov", [attachment.entryCount])}
            </div>
          </div>
          <button
            type="button"
            className="shrink-0 rounded p-1 text-muted-foreground/60 transition hover:bg-background/60 hover:text-destructive"
            aria-label={tf("composer.ubrat_fayl_0", [attachment.name])}
            onClick={() => onRemove(attachment.name)}
          >
            <CloseIcon size={12} />
          </button>
        </div>
      ))}

      {Object.entries(uploadProgress).map(([name, progress]) => (
        <div
          key={`up:${name}`}
          className="flex max-w-[240px] items-center gap-2 rounded-lg border border-border bg-muted/40 py-1.5 pl-1.5 pr-2.5 text-xs"
        >
          <span className="relative flex h-8 w-8 shrink-0 items-center justify-center">
            <span
              className="absolute inset-0 rounded-full"
              style={{
                background: `conic-gradient(var(--color-primary) ${progress * 3.6}deg, color-mix(in srgb, var(--color-border) 100%, transparent) 0deg)`,
              }}
            />
            <span className="absolute inset-[3px] rounded-full bg-card" />
            <span className="relative text-[9px] font-semibold tabular-nums text-foreground/80">
              {progress}
            </span>
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-foreground">{name}</div>
            <div className="text-[11px] text-muted-foreground">Загрузка…</div>
          </div>
        </div>
      ))}
    </div>
  );
}
