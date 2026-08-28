import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
import {
  CloseIcon,
  FilePlusIcon,
  FolderPlusIcon,
  FolderUploadIcon,
  RefreshIcon,
  SearchIcon,
  WorkspaceOpenIcon,
} from "../icons";

interface ButtonGate {
  disabled: boolean;
  title: string;
}

interface WorkspaceToolbarProps {
  treeCount: number;
  filter: string;
  loading: boolean;
  createFileGate: ButtonGate;
  createDirectoryGate: ButtonGate;
  uploadGate: ButtonGate;
  onFilterChange: (value: string) => void;
  onCreateFile: () => void;
  onCreateDirectory: () => void;
  onUpload: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

export function WorkspaceToolbar({
  treeCount,
  filter,
  loading,
  createFileGate,
  createDirectoryGate,
  uploadGate,
  onFilterChange,
  onCreateFile,
  onCreateDirectory,
  onUpload,
  onRefresh,
  onClose,
}: WorkspaceToolbarProps) {
  return (
    <>
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3 safe-top">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-muted-foreground">
            <WorkspaceOpenIcon size={15} />
          </span>
          <span className="truncate text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">
            {t("workspace.files")}
          </span>
          {treeCount > 0 && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none tabular-nums text-muted-foreground">
              {treeCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={onCreateFile}
            {...createFileGate}
            aria-label={t("workspace.novyy_fayl")}
          >
            <FilePlusIcon size={15} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={onCreateDirectory}
            {...createDirectoryGate}
            aria-label={t("sidebar.novaya_papka")}
          >
            <FolderPlusIcon size={15} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={onUpload}
            {...uploadGate}
            aria-label={t("workspace.zagruzit_papku")}
          >
            <FolderUploadIcon size={15} />
          </Button>
          <span
            aria-hidden="true"
            className="mx-0.5 h-4 w-px shrink-0 bg-border"
          />
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={onRefresh}
            title={t("preview_panel.obnovit")}
            aria-label={t("preview_panel.obnovit")}
            disabled={loading}
          >
            <RefreshIcon size={15} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:hidden"
            onClick={onClose}
            title={t("workspace.zakryt_fayly_proekta")}
            aria-label={t("workspace.zakryt_fayly_proekta")}
          >
            <CloseIcon size={15} />
          </Button>
        </div>
      </header>

      <div className="shrink-0 border-b border-border px-2.5 py-2">
        <div className="relative">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
            <SearchIcon size={14} />
          </span>
          <Input
            className="h-8 rounded-lg border-border bg-muted/40 pl-8 pr-8 text-[12px] text-foreground placeholder:text-muted-foreground"
            placeholder={t("workspace.filtr_faylov")}
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
          />
          {filter && (
            <button
              type="button"
              onClick={() => onFilterChange("")}
              className="absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              title={t("workspace.ochistit_filtr")}
              aria-label={t("workspace.ochistit_filtr")}
            >
              <CloseIcon size={12} />
            </button>
          )}
        </div>
      </div>
    </>
  );
}
