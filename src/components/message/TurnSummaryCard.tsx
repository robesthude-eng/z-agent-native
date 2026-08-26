import { t } from "@/i18n";
import { WorkspaceFileChip } from "../AttachmentChip";
import {
  formatDuration,
  pluralRu,
  type TaskOutcomeStatus,
} from "./turnSummary";

interface TurnSummaryCardProps {
  summary: {
    actionsCount: number;
    changedFiles: string[];
    durationMs: number | null;
    failed: boolean;
    stopped: boolean;
    needsInput: boolean;
    outcomeStatus: TaskOutcomeStatus | null;
  };
  strategyMutated: boolean;
  onSelectFile: (path: string) => void;
}

export function TurnSummaryCard({
  summary,
  strategyMutated,
  onSelectFile,
}: TurnSummaryCardProps) {
  const explicit = summary.outcomeStatus;
  const statusLabel =
    explicit === "completed"
      ? t("agent_activity.gotovo")
      : explicit === "partial"
        ? t("changes_panel.chastichno_vypolneno")
        : explicit === "needs_input"
          ? t("changes_panel.nuzhny_dannye")
          : explicit === "failed"
            ? t("changes_panel.oshibka")
            : explicit === "cancelled"
              ? t("message_item.ostanovleno_polzovatelem")
              : summary.failed
                ? t("changes_panel.oshibka")
                : summary.stopped
                  ? t("message_item.ostanovleno_polzovatelem")
                  : summary.needsInput
                    ? t("changes_panel.nuzhny_dannye")
                    : t("agent_activity.gotovo");

  const statusTone =
    explicit === "completed"
      ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20"
      : explicit === "partial"
        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20"
        : explicit === "needs_input"
          ? "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20"
          : explicit === "failed" || summary.failed
            ? "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20"
            : explicit === "cancelled" || summary.stopped
              ? "bg-muted text-muted-foreground border-border"
              : summary.needsInput
                ? "bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20"
                : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20";

  return (
    <div
      data-testid="turn-summary-card"
      className="mt-3 rounded-xl border border-border/70 bg-card/60 p-3 text-xs text-muted-foreground"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${statusTone}`}
        >
          {statusLabel}
        </span>
        <div className="flex flex-wrap items-center gap-3 text-[11px]">
          {summary.durationMs != null && (
            <span>{formatDuration(summary.durationMs)}</span>
          )}
          {summary.actionsCount > 0 && (
            <span>
              {summary.actionsCount}{" "}
              {pluralRu(
                summary.actionsCount,
                t("message_item.deystvie"),
                t("message_item.deystviya"),
                t("message_item.deystviy"),
              )}
            </span>
          )}
          {summary.changedFiles.length > 0 && (
            <span>
              {summary.changedFiles.length}{" "}
              {pluralRu(
                summary.changedFiles.length,
                t("message_item.fayl"),
                t("message_item.fayla"),
                t("message_item.faylov"),
              )}
            </span>
          )}
        </div>
      </div>

      {summary.changedFiles.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 pt-2 border-t border-border/50">
          {summary.changedFiles.map((path) => (
            <WorkspaceFileChip
              key={path}
              name={path.split("/").pop() || path}
              path={path}
            />
          ))}
        </div>
      )}
    </div>
  );
}
