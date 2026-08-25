import { CheckIcon, CloseIcon, PencilIcon, TrashIcon } from "../icons";
import { t, tf } from "@/i18n";

interface SidebarFolderItemProps {
  folderId: string;
  label: string;
  count: number;
  isCollapsed: boolean;
  isEditing: boolean;
  editingDraft: string;
  isConfirmDeleting: boolean;
  onToggleCollapse: () => void;
  onStartEditing: () => void;
  onDraftChange: (val: string) => void;
  onCommitRename: () => void;
  onCancelEditing: () => void;
  onStartDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}

export function SidebarFolderItem({
  folderId,
  label,
  count,
  isCollapsed,
  isEditing,
  editingDraft,
  isConfirmDeleting,
  onToggleCollapse,
  onStartEditing,
  onDraftChange,
  onCommitRename,
  onCancelEditing,
  onStartDelete,
  onConfirmDelete,
  onCancelDelete,
}: SidebarFolderItemProps) {
  return (
    <div className="group/folder flex items-center gap-1 px-1 pb-1 pt-2">
      {isEditing ? (
        <input
          ref={(el) => el?.focus()}
          value={editingDraft}
          onChange={(e) => onDraftChange(e.target.value)}
          onBlur={onCommitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitRename();
            if (e.key === "Escape") onCancelEditing();
          }}
          aria-label={t("sidebar.novoe_nazvanie_papki")}
          className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-foreground outline-none"
        />
      ) : (
        <>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title={tf("sidebar.0_papku_1", [
              isCollapsed ? t("sidebar.razvernut") : t("sidebar.svernut"),
              label,
            ])}
          >
            <span aria-hidden="true">{isCollapsed ? "▸" : "▾"}</span>
            <span className="truncate">{label}</span>
            <span className="shrink-0 opacity-60">{count}</span>
          </button>
          <button
            type="button"
            onClick={onStartEditing}
            title={t("sidebar.pereimenovat_papku")}
            aria-label={tf("sidebar.pereimenovat_papku_0", [label])}
            className="shrink-0 rounded p-0.5 text-[11px] opacity-0 transition group-hover/folder:opacity-60 hover:opacity-100"
          >
            <PencilIcon size={13} />
          </button>
          {isConfirmDeleting ? (
            <span className="mr-1 flex shrink-0 items-center gap-1 rounded-lg border border-destructive/25 bg-destructive/10 py-0.5">
              <span className="pl-1.5 pr-0.5 text-[10px] font-semibold text-destructive">
                {t("sidebar.udalit_vopros")}
              </span>
              <button
                type="button"
                onClick={onConfirmDelete}
                title={t("sidebar.podtverdit_udalenie_papki_chaty_ostanutsya")}
                aria-label={tf("sidebar.podtverdit_udalenie_papki_0", [label])}
                className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-destructive text-background transition hover:brightness-110"
              >
                <CheckIcon size={11} />
              </button>
              <button
                type="button"
                onClick={onCancelDelete}
                title={t("confirm_dialog.otmena")}
                aria-label={t("sidebar.otmenit_udalenie_papki")}
                className="mr-1 inline-flex h-5 w-5 items-center justify-center rounded-md bg-muted text-muted-foreground transition hover:bg-muted-foreground/20"
              >
                <CloseIcon size={11} />
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={onStartDelete}
              title={t("sidebar.udalit_papku")}
              aria-label={tf("sidebar.udalit_papku_0", [label])}
              className="mr-1 shrink-0 rounded p-0.5 text-[11px] opacity-0 transition group-hover/folder:opacity-60 hover:opacity-100"
            >
              <TrashIcon size={13} />
            </button>
          )}
        </>
      )}
    </div>
  );
}
