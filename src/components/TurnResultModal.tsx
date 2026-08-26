import { ChevronDown, ExternalLink, GitBranch, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { t, tf } from "@/i18n";
import {
  changesApi,
  type ProjectChange,
  type ProjectChangeDiff,
  type TurnResult,
} from "../api/changes";
import { toast } from "../lib/toast";
import { useStore } from "../store/useStore";
import PanelModal from "./PanelModal";

type ChangeKind = "added" | "deleted" | "modified";

function kind(status?: string): ChangeKind {
  if (status === "added" || status === "untracked" || status === "A")
    return "added";
  if (status === "deleted" || status === "D") return "deleted";
  return "modified";
}

function statusLabel(status?: string) {
  const value = kind(status);
  if (value === "added") return t("changes_panel.dobavlen");
  if (value === "deleted") return t("changes_panel.udalen");
  return t("changes_panel.izmenen");
}

function statusMark(status?: string) {
  const value = kind(status);
  if (value === "added") return "+";
  if (value === "deleted") return "−";
  return "M";
}

function lineClass(line: string) {
  if (line.startsWith("@@")) return "text-sky-300/85";
  if (line.startsWith("+") && !line.startsWith("+++"))
    return "bg-emerald-500/8 text-emerald-300/90";
  if (line.startsWith("-") && !line.startsWith("---"))
    return "bg-red-500/8 text-red-300/90";
  if (
    line.startsWith("diff --git") ||
    line.startsWith("index ") ||
    line.startsWith("---") ||
    line.startsWith("+++")
  )
    return "text-muted-foreground";
  return "text-foreground/80";
}

function pluralFiles(n: number) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return t("message_item.fayl");
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14))
    return t("message_item.fayla");
  return t("message_item.faylov");
}

export default function TurnResultModal({
  sessionId,
  messageId,
  open,
  onClose,
}: {
  sessionId: string;
  messageId: string;
  open: boolean;
  onClose: () => void;
}) {
  const requestOpenFile = useStore((s) => s.requestOpenFile);
  const [result, setResult] = useState<TurnResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<ProjectChangeDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState<string | null>(null);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [rollingBack, setRollingBack] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await changesApi.turnResult(sessionId, messageId);
      setResult(next);
    } catch (e: unknown) {
      const message =
        (e as Error)?.message ||
        t("turn_result_modal.ne_udalos_poluchit_rezultat_etogo_otveta");
      setResult(null);
      setError(
        /нет сохранённого результата workspace|404/i.test(message)
          ? t("turn_result_modal.etot_otvet_sozdan_do_poyavleniya_snimkov")
          : message,
      );
    } finally {
      setLoading(false);
    }
  }, [messageId, sessionId]);

  useEffect(() => {
    if (!open) return;
    setDiff(null);
    setConfirmRollback(false);
    void load();
  }, [open, load]);

  const counts = useMemo(() => {
    const changes = result?.changes ?? [];
    return changes.reduce(
      (acc, file) => {
        const value = kind(file.status);
        acc[value] += 1;
        return acc;
      },
      { added: 0, deleted: 0, modified: 0 },
    );
  }, [result]);

  const openDiff = useCallback(
    async (file: ProjectChange) => {
      if (diff?.path === file.path) {
        setDiff(null);
        return;
      }
      setDiffLoading(file.path);
      setError(null);
      try {
        setDiff(
          await changesApi.turnResultDiff(sessionId, messageId, file.path),
        );
      } catch (e: unknown) {
        setError(
          (e as Error)?.message || t("changes_panel.ne_udalos_zagruzit_diff"),
        );
      } finally {
        setDiffLoading(null);
      }
    },
    [diff?.path, messageId, sessionId],
  );

  const rollback = useCallback(async () => {
    setRollingBack(true);
    setError(null);
    try {
      const response = await changesApi.rollbackTurn(sessionId, messageId);
      const rolledBackAt = response.rolledBackAt || Date.now();
      setResult((current) =>
        current ? { ...current, rolledBackAt } : current,
      );
      setConfirmRollback(false);
      toast(
        "success",
        response.alreadyRolledBack
          ? t("turn_result_modal.etot_hod_uzhe_byl_otkatan")
          : tf("turn_result_modal.otkat_vypolnen_vosstanovleno_0_1", [
              response.restored.length,
              pluralFiles(response.restored.length),
            ]),
      );
    } catch (e: unknown) {
      const message =
        (e as Error)?.message ||
        t("turn_result_modal.ne_udalos_otkatit_etot_hod");
      setError(message);
      toast("error", message);
    } finally {
      setRollingBack(false);
    }
  }, [messageId, sessionId]);

  const rolledBack = Boolean(result?.rolledBackAt);

  return (
    <PanelModal
      title={t("turn_result_modal.rezultat_etogo_otveta")}
      open={open}
      onClose={onClose}
    >
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="shrink-0 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-foreground">
                {loading
                  ? t("turn_result_modal.zagruzhayu_rezultat")
                  : result
                    ? `${result.changeCount} ${pluralFiles(result.changeCount)}`
                    : t("turn_result_modal.rezultat_hoda")}
              </div>
              {result && (
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  +{counts.added} · ~{counts.modified} · −{counts.deleted}
                  {rolledBack
                    ? t("turn_result_modal.otkat_vypolnen_2")
                    : t("turn_result_modal.snimok_do_posle_sohranen")}
                </div>
              )}
            </div>
            {result && result.changeCount > 0 && (
              <button
                type="button"
                className={`min-h-9 rounded-full border px-3 text-[11px] transition disabled:opacity-40 ${
                  rolledBack
                    ? "border-border text-muted-foreground"
                    : "border-red-500/25 text-red-300 hover:bg-red-500/10"
                }`}
                disabled={rollingBack || rolledBack}
                onClick={() => setConfirmRollback((value) => !value)}
              >
                <span className="inline-flex items-center gap-1.5">
                  <RotateCcw className="h-3 w-3" />
                  {rolledBack
                    ? t("turn_result_modal.otkat_vypolnen")
                    : rollingBack
                      ? t("changes_panel.otkatyvayu")
                      : t("turn_result_modal.otkatit_ves_hod")}
                </span>
              </button>
            )}
          </div>

          {confirmRollback && result && !rolledBack && (
            <div className="mt-3 rounded-xl border border-amber-500/25 bg-amber-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
              <div className="font-medium text-foreground/90">
                {t("turn_result_modal.vernut_proekt_k_sostoyaniyu_do_etogo")}
              </div>
              <div className="mt-1">
                Сервер сначала проверит все {result.changeCount}{" "}
                {pluralFiles(result.changeCount)}. Если более поздняя задача
                изменила хотя бы один из них, откат не начнётся и новая работа
                останется нетронутой.
              </div>
              <div className="mt-2 flex justify-end gap-1">
                <button
                  type="button"
                  className="min-h-9 rounded-full px-3 hover:bg-accent hover:text-foreground"
                  onClick={() => setConfirmRollback(false)}
                  disabled={rollingBack}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="min-h-9 rounded-full bg-red-500/15 px-3 font-medium text-red-300 hover:bg-red-500/25 disabled:opacity-40"
                  onClick={() => void rollback()}
                  disabled={rollingBack}
                >
                  {rollingBack
                    ? t("changes_panel.otkatyvayu")
                    : t("turn_result_modal.podtverdit_otkat")}
                </button>
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="mx-3 mt-3 rounded-lg border border-red-500/25 bg-red-500/8 px-3 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {!loading && result && result.changes.length === 0 && (
            <div className="flex min-h-48 flex-col items-center justify-center px-5 text-center">
              <div className="text-sm font-medium text-foreground">
                {t("turn_result_modal.fayly_ne_menyalis")}
              </div>
              <div className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                Ответ мог выполнять чтение, поиск или проверку — снимки до и
                после совпадают.
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            {result?.changes.map((file) => {
              const expanded = diff?.path === file.path;
              return (
                <div
                  key={`${file.status}:${file.path}`}
                  className="overflow-hidden rounded-xl bg-card/35"
                >
                  <button
                    type="button"
                    className="flex min-h-12 w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-accent/60"
                    onClick={() => void openDiff(file)}
                    aria-expanded={expanded}
                  >
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-card font-mono text-[11px] font-semibold text-muted-foreground">
                      {statusMark(file.status)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-mono text-xs text-foreground/90">
                        {file.path}
                      </span>
                      <span className="mt-0.5 block text-[10.5px] text-muted-foreground">
                        {statusLabel(file.status)}
                      </span>
                    </span>
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-muted-foreground transition ${expanded ? "rotate-180" : ""} ${diffLoading === file.path ? "animate-pulse" : ""}`}
                    />
                  </button>

                  {expanded && diff && (
                    <div className="border-t border-border/70">
                      <div className="flex items-center gap-2 px-3 py-2 text-[10.5px] text-muted-foreground">
                        {!diff.binary && (
                          <>
                            <span className="text-emerald-300/90">
                              +{diff.additions}
                            </span>
                            <span className="text-red-300/90">
                              −{diff.deletions}
                            </span>
                          </>
                        )}
                        {diff.truncated && (
                          <span>{t("changes_panel.diff_sokraschen")}</span>
                        )}
                        {!rolledBack && kind(file.status) !== "deleted" && (
                          <button
                            type="button"
                            className="ml-auto inline-flex min-h-9 items-center gap-1 rounded-full px-2.5 transition hover:bg-accent hover:text-foreground"
                            onClick={() => {
                              onClose();
                              requestOpenFile(file.path);
                            }}
                          >
                            <ExternalLink className="h-3 w-3" />
                            Открыть
                          </button>
                        )}
                      </div>

                      {diff.binary ? (
                        <div className="px-3 pb-3 text-xs text-muted-foreground">
                          {t(
                            "turn_result_modal.dvoichnyy_fayl_izmenen_tekstovyy_diff_nedost",
                          )}
                        </div>
                      ) : (
                        <pre className="max-h-[52dvh] overflow-auto border-t border-border/60 bg-black/15 py-2 font-mono text-[11px] leading-[1.55]">
                          {diff.patch.split("\n").map((line, index) => (
                            <div
                              key={`${index}:${line.slice(0, 32)}`}
                              className={`min-w-max whitespace-pre px-3 ${lineClass(line)}`}
                            >
                              {line || " "}
                            </div>
                          ))}
                        </pre>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </PanelModal>
  );
}
