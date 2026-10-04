import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import {
  CloseIcon,
  RefreshIcon,
  SearchIcon,
  WorkspaceOpenIcon,
} from "../icons";

interface WorkspaceToolbarProps {
  treeCount: number;
  filter: string;
  loading: boolean;
  onFilterChange: (value: string) => void;
  onSearchStart: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

export function WorkspaceToolbar({
  treeCount,
  filter,
  loading,
  onFilterChange,
  onSearchStart,
  onRefresh,
  onClose,
}: WorkspaceToolbarProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const search = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const closeSearch = useCallback(
    (focusTrigger = false) => {
      restoreFocus.current = focusTrigger;
      onFilterChange("");
      setSearchOpen(false);
    },
    [onFilterChange],
  );

  useEffect(() => {
    if (!searchOpen) {
      if (restoreFocus.current) trigger.current?.focus();
      restoreFocus.current = false;
      return;
    }
    field.current?.focus();
    const outside = (event: Event) => {
      if (!search.current?.contains(event.target as Node)) {
        // Close after the target's click handler: clearing a filter before the
        // click can remove a matching nested row and swallow file selection.
        queueMicrotask(() => closeSearch());
      }
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeSearch(true);
    };
    document.addEventListener("click", outside, true);
    document.addEventListener("keydown", onEscape, true);
    return () => {
      document.removeEventListener("click", outside, true);
      document.removeEventListener("keydown", onEscape, true);
    };
  }, [searchOpen, closeSearch]);

  return (
    <header className="workspace-toolbar relative flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border px-3 safe-top">
      {!searchOpen && (
        <>
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-muted-foreground">
              <WorkspaceOpenIcon size={16} />
            </span>
            <span className="truncate text-sm font-medium">Workspace</span>
            {treeCount > 0 && (
              <span className="workspace-file-count tabular-nums">
                {treeCount}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              ref={trigger}
              variant="ghost"
              size="icon"
              className="workspace-toolbar-action"
              aria-label="Поиск файлов"
              title="Поиск файлов"
              aria-expanded={false}
              aria-controls="workspace-file-search"
              onClick={() => {
                onSearchStart();
                setSearchOpen(true);
              }}
            >
              <SearchIcon size={18} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="workspace-toolbar-action"
              onClick={onRefresh}
              title={t("preview_panel.obnovit")}
              aria-label={t("preview_panel.obnovit")}
              disabled={loading}
            >
              <RefreshIcon size={18} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="workspace-toolbar-action"
              onClick={onClose}
              title={t("workspace.zakryt_fayly_proekta")}
              aria-label={t("workspace.zakryt_fayly_proekta")}
            >
              <CloseIcon size={18} />
            </Button>
          </div>
        </>
      )}
      {searchOpen && (
        <search
          id="workspace-file-search"
          ref={search}
          className="workspace-search-shell"
          aria-label="Поиск в workspace"
        >
          <span className="workspace-search-symbol" aria-hidden="true">
            <SearchIcon size={18} />
          </span>
          <Input
            ref={field}
            type="search"
            className="workspace-search-input"
            aria-label="Поиск файлов"
            placeholder={t("workspace.filtr_faylov")}
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="workspace-search-close"
            aria-label="Закрыть поиск файлов"
            title="Закрыть поиск"
            onClick={() => closeSearch(true)}
          >
            <CloseIcon size={17} />
          </Button>
        </search>
      )}
    </header>
  );
}
