import { formatSize, MAX_UPLOAD_BYTES } from "@/api/files";
import { PaperclipIcon } from "../icons";

interface ComposerDropOverlayProps {
  visible: boolean;
}

export function ComposerDropOverlay({ visible }: ComposerDropOverlayProps) {
  if (!visible) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-primary/60 bg-card/90 px-10 py-8 shadow-xl">
        <span className="text-primary">
          <PaperclipIcon size={28} />
        </span>
        <div className="text-center">
          <div className="text-sm font-semibold text-foreground">
            Отпустите, чтобы прикрепить
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            Файлы попадут в workspace этого чата · до{" "}
            {formatSize(MAX_UPLOAD_BYTES)}
          </div>
        </div>
      </div>
    </div>
  );
}
