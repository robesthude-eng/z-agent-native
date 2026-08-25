import type { QueueEntry } from "@/api/sendQueue";
import { t } from "@/i18n";
import { CloseIcon } from "../icons";

interface ComposerQueueProps {
  entries: QueueEntry[];
  onRemove: (entry: QueueEntry) => void;
}

export function ComposerQueue({ entries, onRemove }: ComposerQueueProps) {
  if (entries.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-2 pb-1">
      {entries.map((entry) => (
        <div
          key={entry.actionId}
          className="flex items-center gap-2 rounded-full border border-border bg-muted px-2 py-1 text-xs text-muted-foreground"
          title={entry.text}
        >
          <span className="opacity-60">⏳</span>
          <span className="max-w-[160px] truncate">
            {entry.text ||
              entry.attachments
                ?.map((attachment) => attachment.name)
                .join(", ") ||
              t("composer.vlozhenie")}
          </span>
          <button
            type="button"
            className="hover:text-destructive"
            aria-label={t("composer.ubrat_soobschenie_iz_ocheredi")}
            onClick={() => onRemove(entry)}
          >
            <CloseIcon size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
