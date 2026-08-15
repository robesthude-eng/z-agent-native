import { type ReactNode, Suspense } from "react";
import { Button } from "@/components/ui/button";
import ErrorBoundary from "./ErrorBoundary";

/**
 * Обёртка для панелей, которые грузятся отдельным чанком (терминал,
 * предпросмотр, настройки). Держит вместе две вещи, которые для ленивого
 * импорта обязаны идти в паре:
 *
 *  - Suspense со скелетоном в стиле самой панели — пользователь уже нажал
 *    кнопку и ждёт открытия, поэтому пустой кадр здесь недопустим;
 *  - ErrorBoundary — отвергнутый `import()` пробрасывает ошибку в рендер, и
 *    без границы React снёс бы всё дерево (белый экран вместо чата).
 */
export function LazyPanel({
  label,
  skeleton,
  children,
}: {
  /** Что именно не удалось загрузить — попадает в текст ошибки. */
  label: string;
  skeleton: ReactNode;
  children: ReactNode;
}) {
  return (
    <ErrorBoundary fallback={<ChunkLoadFailure label={label} />}>
      <Suspense fallback={skeleton}>{children}</Suspense>
    </ErrorBoundary>
  );
}

/**
 * Чанк не догрузился. Самый частый источник — вкладка, открытая до
 * пересборки UI (обновление приложения публикует новый build с новыми хэшами имён,
 * см. комментарий про ChunkLoadError в main.tsx): index.html в памяти
 * ссылается на файлы, которых на диске уже нет. Лечится только перезагрузкой —
 * повторный рендер бесполезен, React.lazy кэширует отказ.
 *
 * Оверлей fixed и выше модалок (z-50), чтобы сообщение было видно и когда
 * панель открылась поверх чата.
 */
function ChunkLoadFailure({ label }: { label: string }) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-border bg-background p-5 text-center shadow-lg">
        <p className="text-sm font-medium text-foreground">
          Не удалось загрузить {label}
        </p>
        <p className="mt-1.5 text-xs text-muted-foreground">
          Скорее всего, вкладка открыта со старой версией интерфейса.
        </p>
        <Button
          className="mt-4"
          size="sm"
          type="button"
          onClick={() => window.location.reload()}
        >
          Обновить страницу
        </Button>
      </div>
    </div>
  );
}

/**
 * Скелетон для содержимого PanelModal (терминал, предпросмотр). Шапка модалки
 * с заголовком и кнопкой «Закрыть» рендерится сразу и не ждёт чанк — ждёт
 * только тело.
 */
export function PanelBodySkeleton() {
  return (
    <div className="flex h-full w-full flex-col gap-2 p-3">
      <div className="h-3 w-40 animate-pulse rounded bg-muted" />
      <div className="h-3 w-64 animate-pulse rounded bg-muted/70" />
      <div className="min-h-0 flex-1 animate-pulse rounded-lg bg-muted/40" />
    </div>
  );
}

/** Ширины строк-заглушек меню настроек; ключи — чтобы не индексировать массив. */
const NAV_ROWS = ["w-32", "w-24", "w-28", "w-20", "w-36"];
const BODY_ROWS = ["h-20", "h-16", "h-24"];

/**
 * Скелетон настроек повторяет каркас SettingsPanel (оверлей → окно → меню
 * слева, заголовок и карточки справа), чтобы открытие не начиналось со скачка
 * геометрии, когда приедет настоящая панель.
 */
export function SettingsPanelSkeleton() {
  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-4">
      <div className="flex h-[100dvh] w-full overflow-hidden rounded-none border-0 border-border bg-background shadow-lg sm:h-auto sm:max-h-[85vh] sm:max-w-5xl sm:rounded-xl sm:border">
        <aside className="hidden w-60 shrink-0 flex-col gap-3 border-r border-border bg-muted/20 p-4 md:flex">
          <div className="h-6 w-28 animate-pulse rounded bg-muted" />
          <div className="h-8 w-full animate-pulse rounded-md bg-muted/60" />
          <div className="flex flex-col gap-2 pt-1">
            {NAV_ROWS.map((w) => (
              <div
                key={w}
                className={`h-7 ${w} animate-pulse rounded-xl bg-muted/50`}
              />
            ))}
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex shrink-0 items-center border-b border-border px-3 py-3 sm:px-5 sm:py-4 safe-top">
            <div className="h-5 w-48 animate-pulse rounded bg-muted" />
          </header>
          <div className="flex flex-1 flex-col gap-3 p-4 sm:p-5">
            {BODY_ROWS.map((h) => (
              <div
                key={h}
                className={`${h} animate-pulse rounded-xl bg-muted/40`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
