import React, { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CloseIcon, ExitFullscreenIcon, FullscreenIcon } from "./icons";
import { t } from "@/i18n";

/**
 * Ghost-модалка поверх чата для Terminal / Preview.
 * — кастомные драг-ручки: размер меняется за любой край и угол
 * — перетаскивание окна за шапку
 * — фуллскрин по кнопке или двойному клику по шапке
 * — закрытие по Escape и клику по фону
 */

type Rect = { x: number; y: number; w: number; h: number };
type Dir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const MIN_W = 360;
const MIN_H = 240;

const HANDLES: Array<{ dir: Dir; style: React.CSSProperties }> = [
  {
    dir: "n",
    style: { top: -3, left: 10, right: 10, height: 7, cursor: "n-resize" },
  },
  {
    dir: "s",
    style: { bottom: -3, left: 10, right: 10, height: 7, cursor: "s-resize" },
  },
  {
    dir: "e",
    style: { right: -3, top: 10, bottom: 10, width: 7, cursor: "e-resize" },
  },
  {
    dir: "w",
    style: { left: -3, top: 10, bottom: 10, width: 7, cursor: "w-resize" },
  },
  {
    dir: "ne",
    style: { top: -4, right: -4, width: 14, height: 14, cursor: "ne-resize" },
  },
  {
    dir: "nw",
    style: { top: -4, left: -4, width: 14, height: 14, cursor: "nw-resize" },
  },
  {
    dir: "se",
    style: {
      bottom: -4,
      right: -4,
      width: 14,
      height: 14,
      cursor: "se-resize",
    },
  },
  {
    dir: "sw",
    style: { bottom: -4, left: -4, width: 14, height: 14, cursor: "sw-resize" },
  },
];

function initialRect(): Rect {
  const w = Math.min(920, Math.round(window.innerWidth * 0.94));
  const h = Math.min(
    Math.round(window.innerHeight * 0.7),
    window.innerHeight - 96,
  );
  return {
    x: Math.max(8, Math.round((window.innerWidth - w) / 2)),
    y: 48,
    w,
    h,
  };
}

function clampRect(r: Rect): Rect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(MIN_W, Math.min(r.w, vw));
  const h = Math.max(MIN_H, Math.min(r.h, vh));
  // шапка всегда должна оставаться досягаемой
  const x = Math.max(-w + 80, Math.min(r.x, vw - 80));
  const y = Math.max(0, Math.min(r.y, vh - 40));
  return { x, y, w, h };
}

export default function PanelModal({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const [full, setFull] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);
  const [interacting, setInteracting] = useState(false);
  // Мобильный UX-fix: на узких экранах окно всегда полноэкранное —
  // 7px драг-ручки пальцем не поймать, а драг шапки конфликтует со скроллом.
  const [isMobile, setIsMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const effectiveFull = full || isMobile;
  const rectRef = useRef<Rect | null>(null);
  rectRef.current = rect;

  useEffect(() => {
    if (open && !rectRef.current) setRect(initialRect());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) setFull(false);
  }, [open]);

  // Общая механика драга: вешаем глобальные слушатели до pointerup
  const track = (
    e: React.PointerEvent,
    onMove: (dx: number, dy: number, start: Rect) => Rect,
  ) => {
    if (effectiveFull || !rectRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const start = rectRef.current;
    const px = e.clientX;
    const py = e.clientY;
    setInteracting(true);
    const move = (ev: PointerEvent) => {
      setRect(clampRect(onMove(ev.clientX - px, ev.clientY - py, start)));
    };
    const up = () => {
      setInteracting(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const startResize = (dir: Dir) => (e: React.PointerEvent) =>
    track(e, (dx, dy, s) => {
      let { x, y, w, h } = s;
      if (dir.includes("e")) w = s.w + dx;
      if (dir.includes("s")) h = s.h + dy;
      if (dir.includes("w")) {
        x = s.x + dx;
        w = s.w - dx;
        if (w < MIN_W) {
          x = s.x + s.w - MIN_W;
          w = MIN_W;
        }
      }
      if (dir.includes("n")) {
        y = s.y + dy;
        h = s.h - dy;
        if (h < MIN_H) {
          y = s.y + s.h - MIN_H;
          h = MIN_H;
        }
      }
      return { x, y, w, h };
    });

  const startDrag = (e: React.PointerEvent) => {
    // не тащим окно за кнопки в шапке
    if ((e.target as HTMLElement).closest("button")) return;
    track(e, (dx, dy, s) => ({ ...s, x: s.x + dx, y: s.y + dy }));
  };

  if (!open || !rect) return null;

  return (
    <div className="fixed inset-0 z-50">
      {/* Фон — отдельная кнопка-сосед, а не родитель окна с onClick: закрытие
          кликом мимо доступно и с клавиатуры, а окну больше не нужен
          stopPropagation, чтобы клики внутри не закрывали модалку. */}
      <button
        type="button"
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        onClick={onClose}
        aria-label={t("panel_modal.zakryt_okno")}
      />
      <div
        className={cn(
          "absolute flex flex-col overflow-hidden border border-border bg-background shadow-[0_16px_60px_rgba(0,0,0,0.5)]",
          effectiveFull ? "inset-0 rounded-none" : "rounded-xl",
          interacting && "select-none",
        )}
        style={
          effectiveFull
            ? undefined
            : { left: rect.x, top: rect.y, width: rect.w, height: rect.h }
        }
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: перетаскивание окна и двойной клик «на весь экран» — чисто указательные жесты; с клавиатуры те же действия доступны кнопками «На весь экран»/«Закрыть» в этой же шапке и Escape */}
        <header
          className={cn(
            "flex h-10 shrink-0 items-center gap-1 border-b border-border px-3",
            !effectiveFull && "cursor-grab active:cursor-grabbing",
          )}
          onPointerDown={startDrag}
          onDoubleClick={() => setFull((f) => !f)}
        >
          <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {title}
          </span>
          <span className="flex-1" />
          {!isMobile && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setFull((f) => !f)}
              title={full ? t("panel_modal.svernut_iz_polnogo_ekrana") : t("panel_modal.na_ves_ekran")}
              aria-label={full ? t("panel_modal.svernut_iz_polnogo_ekrana") : t("panel_modal.na_ves_ekran")}
            >
              {full ? (
                <ExitFullscreenIcon size={14} />
              ) : (
                <FullscreenIcon size={14} />
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={onClose}
            title={t("panel_modal.zakryt")}
            aria-label={t("panel_modal.zakryt")}
          >
            <CloseIcon size={14} />
          </Button>
        </header>

        <div
          className={cn(
            "min-h-0 flex-1 overflow-hidden",
            // чтобы iframe не перехватывал курсор во время драга
            interacting && "pointer-events-none",
          )}
        >
          {children}
        </div>

        {/* Драг-ручки по всем краям и углам */}
        {!effectiveFull &&
          HANDLES.map((h) => (
            <div
              key={h.dir}
              className="absolute z-10"
              style={h.style}
              onPointerDown={startResize(h.dir)}
            />
          ))}
      </div>
    </div>
  );
}
