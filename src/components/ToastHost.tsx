import { useToasts } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

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
      {/* Параметр называется `toast`, а не `t`: буквой `t` в этом файле
          названа импортированная функция перевода, и внутри map она
          оказывалась затенена объектом уведомления. Строка ниже пыталась
          вызвать объект как функцию, а ToastHost подключён в корне роутера —
          поэтому первое же всплывшее уведомление гасило всё приложение. */}
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => dismiss(toast.id)}
          title={t("toast_host.skryt_uvedomlenie")}
          className={cn(
            "pointer-events-auto rounded-lg border px-3 py-2 text-left text-sm shadow-e2 break-words",
            KIND_STYLES[toast.kind],
          )}
        >
          <span className="mr-1.5">{KIND_ICONS[toast.kind]}</span>
          {toast.text}
        </button>
      ))}
    </div>
  );
}
