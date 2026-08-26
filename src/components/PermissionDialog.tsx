import { useEffect, useRef } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { t, tf } from "@/i18n";
import { useStore } from "../store/useStore";
import { KeyIcon } from "./icons";

// Native permission protocol uses "once" | "always" | "reject".
// (older versions used "allow" | "deny"). We send the new enum; the server
// validates the body strictly, so anything else is a 400.
type PermissionResponse = "once" | "always" | "reject";

function fmt(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type ToolPresentation = {
  /** Человечное описание — отвечает, чему именно даётся разрешение. */
  action: string;
  /** Главная деталь (команда, путь, URL) из input. */
  detail?: string | undefined;
};

function presentTool(tool: string, input: unknown): ToolPresentation {
  // `kind`, а не `t`: имя `t` занято функцией перевода, импортированной
  // выше. Затенённое строкой, оно превращало каждый вызов t("…") ниже в
  // попытку вызвать строку как функцию — и диалог разрешений ронял корень.
  const kind = tool.toLowerCase();
  const obj = (input && typeof input === "object" ? input : {}) as Record<
    string,
    unknown
  >;
  const str = (k: string) =>
    typeof obj[k] === "string" ? (obj[k] as string) : undefined;

  if (["bash", "shell", "cmd"].includes(kind)) {
    return {
      action: t(
        "permission_dialog.vypolnit_komandu_v_terminale_pesochnicy_etoy",
      ),
      detail: str("command") ?? str("cmd"),
    };
  }
  if (kind === "write") {
    return {
      action: t("permission_dialog.sozdat_ili_perezapisat_fayl_v_pesochnice"),
      detail: str("filePath") ?? str("path") ?? str("file"),
    };
  }
  if (["edit", "multiedit", "patch", "apply_patch"].includes(kind)) {
    return {
      action: t("permission_dialog.izmenit_fayl_v_pesochnice"),
      detail: str("filePath") ?? str("path") ?? str("file"),
    };
  }
  if (["read", "grep", "glob", "list", "ls"].includes(kind)) {
    return {
      action: t("permission_dialog.prochitat_fayly_proekta"),
      detail: str("filePath") ?? str("path") ?? str("pattern"),
    };
  }
  if (["webfetch", "websearch", "fetch"].includes(kind)) {
    return {
      action: t("permission_dialog.vypolnit_zapros_v_internet"),
      detail: str("url") ?? str("query"),
    };
  }
  if (kind === "task") {
    return {
      action: t("permission_dialog.zapustit_fonovuyu_podzadachu"),
      detail: str("description"),
    };
  }
  return { action: tf("permission_dialog.zapustit_instrument_0", [tool]) };
}

/**
 * UX-fix: инлайн-карточка запроса разрешения вместо полноэкранной модалки:
 * — чат остаётся видимым, контекст запроса не теряется;
 * — клик по фону и Esc больше НЕ отклоняют запрос;
 * — описание объясняет суть действия (команда/файл/URL);
 * — скоуп кнопки «Всегда» виден прямо на кнопке.
 */
export default function PermissionDialog() {
  const permissions = useStore((s) => s.permissions);
  const respond = useStore((s) => s.respondPermission);

  const req = permissions[0];
  const queueLen = permissions.length;

  // A11y: переводим фокус на «Разрешить» при появлении карточки
  // и возвращаем обратно, когда очередь запросов опустела.
  const allowRef = useRef<HTMLButtonElement | null>(null);
  const prevFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (req) {
      if (!prevFocusRef.current) {
        prevFocusRef.current = document.activeElement as HTMLElement | null;
      }
      allowRef.current?.focus();
    } else if (prevFocusRef.current) {
      prevFocusRef.current.focus();
      prevFocusRef.current = null;
    }
  }, [req]);

  if (!req) return null;

  const tool = typeof req.tool === "string" && req.tool ? req.tool : "tool";
  const { action, detail } = presentTool(tool, req.input);
  const answer = (r: PermissionResponse) => respond(req.id, r);

  return (
    <section
      className="pointer-events-none fixed inset-x-0 bottom-[116px] z-40 px-3 md:px-6"
      aria-live="polite"
      aria-label={tf("permission_dialog.zapros_razresheniya_0", [action])}
    >
      <div className="pointer-events-auto mx-auto w-full max-w-3xl rounded-xl border border-warning/50 bg-card shadow-e3 animate-in fade-in slide-in-from-bottom-2">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <span aria-hidden="true" className="text-warning">
            <KeyIcon size={15} />
          </span>
          <span className="text-sm font-semibold">
            {t("interruptions.zapros_razresheniya")}
          </span>
          <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
            {tool}
          </span>
          {queueLen > 1 && (
            <Badge variant="secondary" className="ml-auto shrink-0">
              1 из {queueLen}
            </Badge>
          )}
        </div>

        <div className="space-y-3 px-4 py-3">
          <p className="text-sm">{action}</p>

          {detail && (
            <pre className="max-h-32 overflow-auto rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs whitespace-pre-wrap break-all">
              {detail}
            </pre>
          )}

          {req.input != null && (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer select-none hover:text-foreground">
                Все параметры вызова
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-border bg-background p-3 font-mono whitespace-pre-wrap break-all">
                {fmt(req.input)}
              </pre>
            </details>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            <Button
              variant="ghost"
              onClick={() => answer("reject")}
              aria-label={t("permission_dialog.otklonit_etot_zapros")}
            >
              Отклонить
            </Button>
            {/* "once" — безопасный дефолт: только этот вызов */}
            <Button
              ref={allowRef}
              onClick={() => answer("once")}
              aria-label={t("permission_dialog.razreshit_tolko_etot_vyzov")}
            >
              Разрешить
            </Button>
            <Button
              variant="ghost"
              onClick={() => answer("always")}
              aria-label={t(
                "permission_dialog.razreshat_takie_vyzovy_do_konca_tekuschey",
              )}
            >
              Всегда — до конца сессии
            </Button>
          </div>

          <p className="text-[11px] leading-snug text-muted-foreground">
            «Разрешить» — только этот вызов, «Всегда» — до конца сессии.
          </p>
        </div>
      </div>
    </section>
  );
}
