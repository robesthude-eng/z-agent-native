import { Input } from "@/components/ui/input";
import { changedFilesLabel, t, tf } from "@/i18n";
import { GitBranchIcon } from "../icons";
import { STATUS_COLORS, toRelPath } from "./workspaceTreeHelpers";

interface WorkspaceUploadStatusProps {
  uploading: boolean;
  message: string | null;
  progress: number;
  total: number;
  percent: number;
}

export function WorkspaceUploadStatus({
  uploading,
  message,
  progress,
  total,
  percent,
}: WorkspaceUploadStatusProps) {
  if (!uploading && !message) return null;
  return (
    <div
      className="shrink-0 space-y-1.5 border-b border-border px-2.5 py-2"
      aria-live="polite"
    >
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">{message}</span>
        {uploading && total > 0 && (
          <span className="shrink-0 tabular-nums">
            {progress}/{total}
          </span>
        )}
      </div>
      {uploading && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all duration-200"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
    </div>
  );
}

interface WorkspaceCreateFormProps {
  kind: "file" | "directory" | null;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function WorkspaceCreateForm({
  kind,
  value,
  onChange,
  onSubmit,
  onCancel,
}: WorkspaceCreateFormProps) {
  if (!kind) return null;
  return (
    <div className="shrink-0 border-b border-border px-2.5 py-2">
      <Input
        autoFocus
        className="h-8 rounded-lg border-border bg-card font-mono text-[11px]"
        placeholder={kind === "directory" ? "src/components" : "src/index.ts"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onSubmit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <p className="mt-1.5 px-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
        {t("workspace.put_ot_kornya_workspace_enter_sozdat")}
      </p>
    </div>
  );
}

interface WorkspaceGitChangesProps {
  files: { path: string; status?: string }[];
  onOpen: (path: string) => void;
}

function statusColor(status?: string): string {
  return STATUS_COLORS[status ?? ""] || "var(--color-muted-foreground)";
}

export function WorkspaceGitChanges({
  files,
  onOpen,
}: WorkspaceGitChangesProps) {
  if (files.length === 0) return null;
  return (
    <div className="shrink-0 border-b border-border px-2.5 pb-2">
      <div className="mb-0.5 flex items-center gap-1.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        <span className="text-warning">
          <GitBranchIcon size={13} />
        </span>
        {changedFilesLabel(files.length)}
      </div>
      <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
        {files.slice(0, 8).map((file) => (
          <button
            type="button"
            className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-muted"
            key={file.path}
            onClick={() => onOpen(file.path)}
            title={toRelPath(file.path)}
          >
            <span
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold"
              style={{
                color: statusColor(file.status),
                background: `color-mix(in srgb, ${statusColor(file.status)} 18%, transparent)`,
              }}
            >
              {(file.status ?? "?").charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0 truncate font-mono text-muted-foreground">
              {toRelPath(file.path)}
            </span>
          </button>
        ))}
        {files.length > 8 && (
          <span className="px-1.5 pt-0.5 text-[11px] text-muted-foreground/80">
            {tf("workspace.esche_0", [files.length - 8])}
          </span>
        )}
      </div>
    </div>
  );
}
