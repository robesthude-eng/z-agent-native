import { useToasts } from "@/lib/toast";
import { cn } from "@/lib/utils";

const KIND_STYLES = {
  success: "border-foreground/40 bg-popover text-foreground",
  error: "border-red-500/60 bg-popover text-foreground",
  info: "border-border bg-popover text-foreground",
} as const;

const KIND_ICONS = {
  success: "✅",
  error: "⚠️",
  info: "ℹ️",
} as const;

export default function ToastHost() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div
      className="pointer-events-none fixed right-3 top-14 z-[70] flex w-[min(320px,calc(100vw-24px))] flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => dismiss(t.id)}
          title="Скрыть уведомление"
          className={cn(
            "pointer-events-auto rounded-lg border px-3 py-2 text-left text-sm shadow-e2 break-words",
            KIND_STYLES[t.kind],
          )}
        >
          <span className="mr-1.5">{KIND_ICONS[t.kind]}</span>
          {t.text}
        </button>
      ))}
    </div>
  );
}
