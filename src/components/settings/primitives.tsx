import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Атомы настроек — единые кирпичи для всех разделов («по классике»,
 * как в системных настройках: секция → карточка → строки через разделитель).
 *
 * SettingsSection — заголовок секции (маленькие капс-буквы) + описание.
 * SettingsCard   — группирующая карточка; строки внутри делятся divide-y.
 * SettingsRow    — строка «название/описание слева — контрол справа»,
 *                  живёт внутри SettingsCard.
 *
 * Любой новый раздел («Настройки чата», «Подключение MCP») собирается
 * из них — так все разделы гарантированно выглядят одинаково.
 */

/** Секция раздела: капс-заголовок + описание + опциональные действия справа. */
export function SettingsSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  /** Ссылка или кнопка в правом углу шапки секции. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2.5">
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 px-1">
        <div className="min-w-0">
          <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted-foreground">
            {title}
          </h3>
          {description && (
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground/80">
              {description}
            </p>
          )}
        </div>
        {actions && <div className="shrink-0 text-sm">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** Группирующая карточка секции: строки внутри разделяются линиями. */
export function SettingsCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border border-border bg-card",
        "divide-y divide-border",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Строка настройки внутри карточки: название и описание слева, контрол справа. */
export function SettingsRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {description && (
          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {children && (
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      )}
    </div>
  );
}
