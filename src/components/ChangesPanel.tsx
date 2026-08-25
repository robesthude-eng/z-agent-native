import {
  ChevronDown,
  ExternalLink,
  GitBranch,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { api } from "../api/client";
import {
  changesApi,
  type ProjectChange,
  type ProjectChangeDiff,
} from "../api/changes";
import { isTmpSession } from "../lib/ids";
import { useStore } from "../store/useStore";
import { t, tf } from "@/i18n";

type ChangeKind = "added" | "deleted" | "renamed" | "modified";

type ResultInfo = {
  outcome?: { status?: string; label?: string };
  strategy?: {
    changed?: boolean;
    verificationAttempts?: number;
    lastVerificationOk?: boolean | null;
    toolErrors?: number;
  };
};

function changeKind(status?: string): ChangeKind {
  const value = String(status || "")
    .trim()
    .toLowerCase();
  if (
    value === "added" ||
    value === "untracked" ||
    value === "a" ||
    value === "??"
  )
    return "added";
  if (value === "deleted" || value === "d") return "deleted";
  if (value === "renamed" || value === "r") return "renamed";
  return "modified";
}

function statusLabel(status?: string) {
  const kind = changeKind(status);
  if (kind === "added") return t("changes_panel.dobavlen");
  if (kind === "deleted") return t("changes_panel.udalen");
  if (kind === "renamed") return t("changes_panel.pereimenovan");
  return t("changes_panel.izmenen");
}

function statusMark(status?: string) {
  const kind = changeKind(status);
  if (kind === "added") return "+";
  if (kind === "deleted") return "−";
  if (kind === "renamed") return "R";
  return "M";
}

function resultLabel(status?: string) {
  if (status === "completed") return t("agent_activity.gotovo");
  if (status === "partial") return t("changes_panel.chastichno_vypolneno");
  if (status === "needs_input") return t("changes_panel.nuzhny_dannye");
  if (status === "failed") return t("changes_panel.oshibka");
  if (status === "cancelled") return t("changes_panel.ostanovleno");
  return null;
}

function diffLineClass(line: string) {
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

export default function ChangesPanel() {
  const currentID = useStore((s) => s.currentID);
  const requestOpenFile = useStore((s) => s.requestOpenFile);
  const _workspaceRevision = useStore((s) =>
    currentID ? (s.workspaceRevision[currentID] ?? 0) : 0,
  );
  const messages = useStore((s) =>
    currentID ? (s.messages[currentID] ?? []) : [],
  );
  const [files, setFiles] = useState<ProjectChange[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<ProjectChangeDiff | null>(null);
  const [diffLoadingPath, setDiffLoadingPath] = useState<string | null>(null);
  const [confirmRevertPath, setConfirmRevertPath] = useState<string | null>(
    null,
  );
  const [revertingPath, setRevertingPath] = useState<string | null>(null);

  const ready = !!currentID && !isTmpSession(currentID);

  const latestResult = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message?.role !== "assistant") continue;
      const info = message.info as
        | (ResultInfo & Record<string, unknown>)
        | undefined;
      if (info?.outcome || info?.strategy) return info;
    }
    return null;
  }, [messages]);

  const verification = useMemo(() => {
    const strategy = latestResult?.strategy;
    if (!strategy?.changed) return null;
    const attempts = Number(strategy.verificationAttempts) || 0;
    if (strategy.lastVerificationOk === true) {
      return {
        label: t("changes_panel.proverka_proydena"),
        detail:
          attempts > 0
            ? tf("changes_panel.0_zapuskov", [attempts])
            : t("changes_panel.uspeshno"),
        tone: "text-emerald-300",
      };
    }
    if (strategy.lastVerificationOk === false) {
      return {
        label: t("changes_panel.proverka_ne_proshla"),
        detail:
          attempts > 0
            ? tf("changes_panel.0_zapuskov", [attempts])
            : t("changes_panel.est_oshibka"),
        tone: "text-amber-300",
      };
    }
    return {
      label:
        attempts > 0
          ? t("changes_panel.proverka_ne_podtverzhdena")
          : t("changes_panel.proverka_ne_zapuskalas"),
      detail:
        attempts > 0
          ? tf("changes_panel.0_popytok", [attempts])
          : t("changes_panel.rezultat_trebuet_proverki"),
      tone: "text-muted-foreground",
    };
  }, [latestResult]);

  const refresh = useCallback(async () => {
    if (!ready || !currentID) {
      setFiles([]);
      setDiff(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.gitStatus(currentID);
      const next = Array.isArray(result) ? (result as ProjectChange[]) : [];
      setFiles(next);
      setDiff((current) =>
        current && next.some((file) => file.path === current.path)
          ? current
          : null,
      );
    } catch (e: unknown) {
      setError(
        (e as Error)?.message ||
          t("changes_panel.ne_udalos_poluchit_izmeneniya"),
      );
    } finally {
      setLoading(false);
    }
  }, [currentID, ready]);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh]);

  const counts = useMemo(() => {
    let added = 0;
    let modified = 0;
    let deleted = 0;
    for (const file of files) {
      const kind = changeKind(file.status);
      if (kind === "added") added += 1;
      else if (kind === "deleted") deleted += 1;
      else modified += 1;
    }
    return { added, modified, deleted };
  }, [files]);

  const openDiff = useCallback(
    async (file: ProjectChange) => {
      if (!currentID) return;
      if (diff?.path === file.path) {
        setDiff(null);
        setConfirmRevertPath(null);
        return;
      }
      setDiffLoadingPath(file.path);
      setConfirmRevertPath(null);
      setError(null);
      try {
        setDiff(await changesApi.diff(currentID, file.path));
      } catch (e: unknown) {
        setError(
          (e as Error)?.message || t("changes_panel.ne_udalos_zagruzit_diff"),
        );
      } finally {
        setDiffLoadingPath(null);
      }
    },
    [currentID, diff?.path],
  );

  const revert = useCallback(
    async (file: ProjectChange) => {
      if (!currentID) return;
      setRevertingPath(file.path);
      setError(null);
      try {
        await changesApi.revert(currentID, file.path);
        toast("success", tf("changes_panel.izmenenie_otmeneno_0", [file.path]));
        setConfirmRevertPath(null);
        setDiff(null);
        await refresh();
      } catch (e: unknown) {
        const message =
          (e as Error)?.message ||
          t("changes_panel.ne_udalos_otkatit_izmenenie");
        setError(message);
        toast("error", message);
      } finally {
        setRevertingPath(null);
      }
    },
    [currentID, refresh],
  );

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Создайте или откройте чат, чтобы увидеть изменения проекта.
      </div>
    );
  }

  const outcome = resultLabel(latestResult?.outcome?.status);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">
              {t("changes_panel.rezultat_raboty")}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">
              {files.length === 0
                ? t("changes_panel.rabochaya_oblast_bez_izmeneniy")
                : tf("changes_panel.0_faylov_1_2_3", [
                    files.length,
                    counts.added,
                    counts.modified,
                    counts.deleted,
                  ])}
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-lg text-muted-foreground"
            onClick={() => refresh().catch(() => {})}
            disabled={loading}
            title={t("changes_panel.obnovit_izmeneniya")}
            aria-label={t("changes_panel.obnovit_izmeneniya")}
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </div>

        {(outcome || verification) && (
          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
            {outcome && (
              <span className="rounded-full border border-border bg-card px-2.5 py-1 text-foreground/85">
                {outcome}
              </span>
            )}
            {verification && (
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 ${verification.tone}`}
              >
                <ShieldCheck className="h-3 w-3" />
                {verification.label} · {verification.detail}
              </span>
            )}
          </div>
        )}
      </div>

      {error && (
        <div className="mx-3 mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {!loading && files.length === 0 && !error ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-2 px-4 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
              ✓
            </div>
            <div className="text-sm font-medium text-foreground">
              {t("changes_panel.vse_chisto")}
            </div>
            <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
              Когда агент изменит файлы, здесь появятся diff и результат
              проверки.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {files.map((file) => {
              const expanded = diff?.path === file.path;
              const loadingDiff = diffLoadingPath === file.path;
              const confirming = confirmRevertPath === file.path;
              const reverting = revertingPath === file.path;
              return (
                <div
                  key={`${file.status}:${file.path}`}
                  className="overflow-hidden rounded-xl border border-transparent bg-card/35 transition focus-within:border-border"
                >
                  <button
                    type="button"
                    className="flex min-h-12 w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-accent/60"
                    onClick={() => openDiff(file).catch(() => {})}
                    aria-expanded={expanded}
                    title={tf("changes_panel.pokazat_izmeneniya_0", [
                      file.path,
                    ])}
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
                        {file.originalPath
                          ? tf("changes_panel.iz_0", [file.originalPath])
                          : ""}
                      </span>
                    </span>
                    <ChevronDown
                      className={`h-4 w-4 shrink-0 text-muted-foreground transition ${expanded ? "rotate-180" : ""} ${loadingDiff ? "animate-pulse" : ""}`}
                    />
                  </button>

                  {expanded && diff && (
                    <div className="border-t border-border/70">
                      <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-[10.5px] text-muted-foreground">
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
                        <span className="ml-auto flex gap-1">
                          {changeKind(file.status) !== "deleted" && (
                            <button
                              type="button"
                              className="inline-flex min-h-9 items-center gap-1 rounded-full px-2.5 text-muted-foreground transition hover:bg-accent hover:text-foreground"
                              onClick={() => requestOpenFile(file.path)}
                            >
                              <ExternalLink className="h-3 w-3" />
                              Открыть
                            </button>
                          )}
                          <button
                            type="button"
                            className="inline-flex min-h-9 items-center gap-1 rounded-full px-2.5 text-muted-foreground transition hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40"
                            onClick={() =>
                              setConfirmRevertPath(
                                confirming ? null : file.path,
                              )
                            }
                            disabled={reverting}
                          >
                            <RotateCcw className="h-3 w-3" />
                            Откатить
                          </button>
                        </span>
                      </div>

                      {confirming && (
                        <div className="mx-3 mb-2 rounded-lg border border-amber-500/25 bg-amber-500/8 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
                          <div className="text-foreground/90">
                            {t("changes_panel.otmenit_izmenenie_etogo_fayla")}
                          </div>
                          <div className="mt-1">
                            {changeKind(file.status) === "added"
                              ? t(
                                  "changes_panel.novyy_fayl_budet_udalen_iz_workspace",
                                )
                              : t(
                                  "changes_panel.fayl_budet_vosstanovlen_do_sostoyaniya_git",
                                )}
                          </div>
                          <div className="mt-2 flex justify-end gap-1">
                            <button
                              type="button"
                              className="min-h-9 rounded-full px-3 hover:bg-accent hover:text-foreground"
                              onClick={() => setConfirmRevertPath(null)}
                              disabled={reverting}
                            >
                              Отмена
                            </button>
                            <button
                              type="button"
                              className="min-h-9 rounded-full bg-red-500/15 px-3 font-medium text-red-300 hover:bg-red-500/25 disabled:opacity-40"
                              onClick={() => revert(file).catch(() => {})}
                              disabled={reverting}
                            >
                              {reverting
                                ? t("changes_panel.otkatyvayu")
                                : t("changes_panel.otkatit_fayl")}
                            </button>
                          </div>
                        </div>
                      )}

                      {diff.binary ? (
                        <div className="px-3 pb-3 text-xs text-muted-foreground">
                          Двоичный файл изменён. Текстовый diff недоступен.
                        </div>
                      ) : (
                        <pre className="max-h-[52vh] overflow-auto border-t border-border/60 bg-background/55 py-2 text-[10.5px] leading-[1.55]">
                          {diff.patch.split("\n").map((line, index) => (
                            <div
                              key={`${index}:${line.slice(0, 24)}`}
                              className={`min-w-max px-3 font-mono ${diffLineClass(line)}`}
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
        )}
      </div>
    </div>
  );
}
