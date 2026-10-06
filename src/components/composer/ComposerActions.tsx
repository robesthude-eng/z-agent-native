import {
  ChevronRight,
  FilePlus,
  Folder,
  Globe,
  ImagePlus,
  Plus,
  Sparkles,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { parseRuntimeCapabilities } from "@/api/runtimeCapabilities";
import { t } from "@/i18n";
import {
  bashFirstPreference,
  setBashFirstPreference,
  setWebSearchPreference,
  webSearchPreference,
} from "@/lib/chatTools";
import { useStore } from "@/store/useStore";
import { SendIcon, StopIcon } from "../icons";

export function ComposerActions({
  busy,
  canSend,
  blockedReason,
  onSend,
  onStop,
  onFiles,
  onPhotos,
  onSkills,
}: {
  busy: boolean;
  canSend: boolean;
  blockedReason: string | null;
  onSend: () => void;
  onStop: () => void;
  onFiles: () => void;
  onPhotos: () => void;
  onSkills: () => void;
}) {
  const session = useStore((s) => s.currentID);
  const owner = useStore((s) => s.currentUser?.email || "");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState(() =>
    webSearchPreference(owner, session),
  );
  const [searchAvailable, setSearchAvailable] = useState<boolean | null>(null);
  const [bashFirst, setBashFirst] = useState(() =>
    bashFirstPreference(owner, session),
  );
  const [bashAvailable, setBashAvailable] = useState<boolean | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setSearch(webSearchPreference(owner, session));
    setBashFirst(bashFirstPreference(owner, session));
    setOpen(false);
  }, [owner, session]);
  useEffect(() => {
    let disposed = false;
    api
      .runtimeCapabilities()
      .then((raw) => {
        if (disposed) return;
        const tools = parseRuntimeCapabilities(raw)?.tools || [];
        setSearchAvailable(tools.includes("websearch"));
        setBashAvailable(tools.includes("bash"));
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const buttons = [
          ...(menu.current?.querySelectorAll<HTMLButtonElement>(
            "button:not(:disabled)",
          ) || []),
        ];
        const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (buttons.length) {
          e.preventDefault();
          buttons[
            (i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length
          ]?.focus();
        }
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);
  const action = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  const toggleSearch = () => {
    const next = !search;
    setSearch(next);
    setWebSearchPreference(owner, session, next);
    setOpen(false);
    trigger.current?.focus();
  };
  const toggleBashFirst = () => {
    const next = !bashFirst;
    setBashFirst(next);
    setBashFirstPreference(owner, session, next);
    setOpen(false);
    trigger.current?.focus();
  };
  return (
    <div className="composer-toolbar">
      <div className="relative" ref={root}>
        <button
          type="button"
          ref={trigger}
          className="composer-plus"
          aria-label="Добавить файлы, скиллы и инструменты"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls="composer-tools-menu"
          onClick={() => setOpen((v) => !v)}
        >
          <Plus size={23} strokeWidth={2.8} />
        </button>
        {open && (
          <div
            ref={menu}
            role="menu"
            id="composer-tools-menu"
            aria-label="Инструменты сообщения"
            className="composer-tools-menu"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => action(onFiles)}
            >
              <FilePlus size={18} />
              <span>Добавить файлы</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => action(onPhotos)}
            >
              <ImagePlus size={18} />
              <span>Добавить фото</span>
            </button>
            <hr className="composer-menu-separator" />
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => action(onSkills)}
            >
              <Sparkles size={18} />
              <span>Скиллы этого чата</span>
              <ChevronRight size={16} />
            </button>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={search && searchAvailable === true}
              disabled={busy || searchAvailable !== true}
              title={
                searchAvailable === false
                  ? "Веб-поиск выключен политикой сервера"
                  : searchAvailable === null
                    ? "Проверяем доступность веб-поиска"
                    : "Управляет веб-поиском в следующих запросах этого чата"
              }
              onClick={toggleSearch}
            >
              <Globe size={18} />
              <span>Веб-поиск</span>
              <span
                className="composer-switch"
                data-checked={search && searchAvailable === true}
                aria-hidden="true"
              />
            </button>
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={bashFirst && bashAvailable === true}
              disabled={busy || bashAvailable !== true}
              title={
                bashAvailable === false
                  ? "Оболочка недоступна на этом сервере"
                  : bashAvailable === null
                    ? "Проверяем доступность оболочки"
                    : "Агент работает через команды shell вместо read/grep/glob. Применяется к следующим запросам этого чата"
              }
              onClick={toggleBashFirst}
            >
              <Terminal size={18} />
              <span>Bash-first</span>
              <span
                className="composer-switch"
                data-checked={bashFirst && bashAvailable === true}
                aria-hidden="true"
              />
            </button>
            <hr className="composer-menu-separator" />
            <button
              type="button"
              role="menuitem"
              onClick={() =>
                action(() =>
                  useStore.setState({
                    settingsOpen: true,
                    settingsInitialTab: "memory",
                  }),
                )
              }
            >
              <Folder size={18} />
              <span>Библиотека скиллов</span>
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>
      {!search && searchAvailable && (
        <span className="composer-tool-chip">
          <Globe size={14} />
          Без веб-поиска
          <button
            type="button"
            className="h-11 w-11 flex items-center justify-center"
            aria-label="Включить веб-поиск"
            disabled={busy}
            onClick={toggleSearch}
          >
            <X size={14} />
          </button>
        </span>
      )}
      {bashFirst && bashAvailable && (
        <span className="composer-tool-chip">
          <Terminal size={14} />
          Bash-first
          <button
            type="button"
            className="h-11 w-11 flex items-center justify-center"
            aria-label="Выключить Bash-first"
            disabled={busy}
            onClick={toggleBashFirst}
          >
            <X size={14} />
          </button>
        </span>
      )}
      <span className="flex-1" />
      <button
        type="button"
        className="composer-submit"
        data-busy={busy}
        data-active={busy || canSend}
        disabled={!busy && !canSend}
        onClick={busy ? onStop : onSend}
        title={
          busy ? t("stop.action") : blockedReason || t("composer.otpravit")
        }
        aria-label={
          busy ? t("stop.action") : t("composer.otpravit_soobschenie")
        }
      >
        <span className="composer-submit-disc">
          {busy ? <StopIcon size={12} /> : <SendIcon size={17} />}
        </span>
      </button>
    </div>
  );
}
