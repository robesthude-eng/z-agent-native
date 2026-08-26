import { t, tf } from "@/i18n";
import { cn } from "@/lib/utils";
import type { SessionInfo } from "../../api/types";
import {
  CheckIcon,
  CloseIcon,
  FolderIcon,
  PencilIcon,
  PinIcon,
  TrashIcon,
} from "../icons";

export interface SidebarChatItemProps {
  session: SessionInfo;
  isActive: boolean;
  displayTitle: string;
  isPinned: boolean;
  busy: boolean;
  isEditing: boolean;
  editText: string;
  isConfirmDeleting: boolean;
  folderMenuOpen: boolean;
  chatFolders: Array<{ id: string; name: string }>;
  currentFolderId?: string | undefined;
  newFolderName: string;
  onSelect: () => void;
  onStartEditing: () => void;
  onEditTextChange: (val: string) => void;
  onCommitRename: () => void;
  onCancelEditing: () => void;
  onTogglePin: () => void;
  onToggleFolderMenu: () => void;
  onAssignFolder: (folderId: string | null) => void;
  onNewFolderNameChange: (val: string) => void;
  onCreateFolderAndAssign: () => void;
  onStartDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

export function SidebarChatItem({
  session,
  isActive,
  displayTitle,
  isPinned,
  busy,
  isEditing,
  editText,
  isConfirmDeleting,
  folderMenuOpen,
  chatFolders,
  currentFolderId,
  newFolderName,
  onSelect,
  onStartEditing,
  onEditTextChange,
  onCommitRename,
  onCancelEditing,
  onTogglePin,
  onToggleFolderMenu,
  onAssignFolder,
  onNewFolderNameChange,
  onCreateFolderAndAssign,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete,
}: SidebarChatItemProps) {
  return (
    <div>
      <div
        className={cn(
          "group relative flex w-full max-w-full items-stretch gap-0.5 overflow-hidden rounded-lg text-[12px] transition-colors",
          isActive
            ? "oc-reveal-open bg-accent text-foreground"
            : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
        )}
      >
        {isActive && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-foreground/70"
          />
        )}
        {isEditing ? (
          <input
            ref={(el) => el?.focus()}
            value={editText}
            onChange={(e) => onEditTextChange(e.target.value)}
            onBlur={onCommitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommitRename();
              if (e.key === "Escape") onCancelEditing();
            }}
            aria-label={t("sidebar.novoe_nazvanie_chata")}
            style={{ flex: 1, minWidth: 0 }}
            className="mx-2 my-1.5 self-center rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={onSelect}
            title={displayTitle}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-lg border-none bg-transparent py-2 pl-2.5 pr-0.5 text-left font-[inherit] text-current outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {busy && (
              <span
                aria-hidden="true"
                className="live-dot shrink-0"
                style={{ background: "var(--color-info)" }}
              />
            )}
            <span className="min-w-0 flex-1 truncate">{displayTitle}</span>
          </button>
        )}
        {isEditing ? null : (
          <>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin();
              }}
              title={
                isPinned
                  ? t("sidebar.otkrepit_chat")
                  : t("sidebar.zakrepit_chat")
              }
              aria-label={tf("sidebar.0_chat_1", [
                isPinned ? t("sidebar.otkrepit") : t("sidebar.zakrepit"),
                displayTitle,
              ])}
              className={cn(
                "oc-reveal inline-flex h-6 w-6 shrink-0 self-center items-center justify-center rounded-md border-none bg-transparent p-0 text-[11px] leading-none text-current transition-all hover:bg-accent active:scale-90",
                isPinned ? "opacity-90" : "opacity-45 hover:opacity-100",
              )}
            >
              <PinIcon size={13} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleFolderMenu();
              }}
              title={t("sidebar.papka_chata")}
              aria-label={tf("sidebar.vybrat_papku_dlya_chata_0", [
                displayTitle,
              ])}
              className={cn(
                "oc-reveal inline-flex h-6 w-6 shrink-0 self-center items-center justify-center rounded-md border-none bg-transparent p-0 text-[11px] leading-none text-current transition-all hover:bg-accent active:scale-90",
                currentFolderId ? "opacity-90" : "opacity-45 hover:opacity-100",
              )}
            >
              <FolderIcon size={13} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onStartEditing();
              }}
              title={t("sidebar.pereimenovat_chat")}
              aria-label={tf("sidebar.pereimenovat_chat_0", [displayTitle])}
              className="oc-reveal inline-flex h-6 w-6 shrink-0 self-center items-center justify-center rounded-md border-none bg-transparent p-0 text-[11px] leading-none text-current opacity-45 transition-all hover:bg-accent hover:opacity-100 active:scale-90"
            >
              <PencilIcon size={13} />
            </button>
          </>
        )}
        {isConfirmDeleting ? (
          <div className="mr-0.5 flex items-center gap-0.5 self-center rounded-md border border-destructive/25 bg-destructive/10 py-0.5">
            <span className="pl-1 pr-0.5 text-[10px] font-semibold text-destructive">
              {t("sidebar.udalit_vopros")}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onConfirmDelete();
              }}
              title={t("sidebar.podtverdit_udalenie")}
              className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-destructive text-background transition hover:brightness-110"
            >
              <CheckIcon size={11} />
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCancelDelete();
              }}
              title={t("confirm_dialog.otmena")}
              className="mr-0.5 inline-flex h-5 w-5 items-center justify-center rounded-md bg-muted text-muted-foreground transition hover:bg-muted-foreground/20"
            >
              <CloseIcon size={11} />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onStartDelete();
            }}
            title={t("sidebar.udalit_chat")}
            aria-label={tf("sidebar.udalit_chat_0", [displayTitle])}
            className="oc-reveal mr-0.5 inline-flex h-6 w-6 shrink-0 self-center items-center justify-center rounded-md border-none bg-transparent p-0 text-current opacity-45 transition-all hover:bg-destructive/15 hover:text-destructive hover:opacity-100 active:scale-90"
          >
            <TrashIcon size={14} />
          </button>
        )}
      </div>

      {folderMenuOpen && (
        <div className="mt-1 rounded-xl border border-border bg-card p-2 text-xs shadow-lg space-y-1">
          <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {t("sidebar.papka_chata")}
          </p>
          <button
            type="button"
            onClick={() => onAssignFolder(null)}
            className={cn(
              "flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-[11px] hover:bg-accent",
              !currentFolderId
                ? "font-semibold text-foreground"
                : "text-muted-foreground",
            )}
          >
            <span>{t("sidebar.bez_papki")}</span>
            {!currentFolderId && <span>✓</span>}
          </button>
          {chatFolders.map((f) => {
            const isAssigned = currentFolderId === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => onAssignFolder(f.id)}
                className={cn(
                  "flex w-full items-center justify-between rounded-lg px-2 py-1 text-left text-[11px] hover:bg-accent",
                  isAssigned
                    ? "font-semibold text-foreground"
                    : "text-muted-foreground",
                )}
              >
                <span className="truncate">{f.name}</span>
                {isAssigned && <span>✓</span>}
              </button>
            );
          })}
          <div className="pt-1 border-t border-border flex gap-1">
            <input
              value={newFolderName}
              onChange={(e) => onNewFolderNameChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onCreateFolderAndAssign();
              }}
              placeholder={t("sidebar.novaya_papka")}
              aria-label={t("sidebar.nazvanie_novoy_papki")}
              className="flex-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-foreground outline-none"
            />
            <button
              type="button"
              onClick={onCreateFolderAndAssign}
              className="rounded-md bg-foreground px-2 py-0.5 text-[11px] text-background hover:brightness-110"
            >
              +
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
