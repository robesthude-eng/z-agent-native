import { GitBranch, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { api } from "../api/client";
import { isTmpSession } from "../lib/ids";
import { useStore } from "../store/useStore";

interface ChangedFile {
  path: string;
  status?: string;
}

type ChangeKind = "added" | "deleted" | "renamed" | "modified";

function changeKind(status?: string): ChangeKind {
  const value = String(status || "").trim().toLowerCase();
  if (value === "added" || value === "untracked" || value === "a" || value === "??") return "added";
  if (value === "deleted" || value === "d") return "deleted";
  if (value === "renamed" || value === "r") return "renamed";
  return "modified";
}

function statusLabel(status?: string) {
  const kind = changeKind(status);
  if (kind === "added") return "Добавлен";
  if (kind === "deleted") return "Удалён";
  if (kind === "renamed") return "Переименован";
  return "Изменён";
}

function statusMark(status?: string) {
  const kind = changeKind(status);
  if (kind === "added") return "+";
  if (kind === "deleted") return "−";
  if (kind === "renamed") return "R";
  return "M";
}

export default function ChangesPanel() {
  const currentID = useStore((s) => s.currentID);
  const requestOpenFile = useStore((s) => s.requestOpenFile);
  const workspaceRevision = useStore((s) =>
    currentID ? (s.workspaceRevision[currentID] ?? 0) : 0,
  );
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = !!currentID && !isTmpSession(currentID);

  const refresh = useCallback(async () => {
    if (!ready || !currentID) {
      setFiles([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const result = await api.gitStatus(currentID);
      setFiles(Array.isArray(result) ? (result as ChangedFile[]) : []);
    } catch (e: unknown) {
      setError((e as Error)?.message || "Не удалось получить изменения");
    } finally {
      setLoading(false);
    }
  }, [currentID, ready]);

  useEffect(() => {
    refresh().catch(() => {});
  }, [refresh, workspaceRevision]);

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

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Создайте или откройте чат, чтобы увидеть изменения проекта.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <GitBranch className="h-4 w-4 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">Изменения проекта</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {files.length === 0
              ? "Рабочая область без изменений"
              : `${files.length} файлов · +${counts.added} · ~${counts.modified} · −${counts.deleted}`}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg text-muted-foreground"
          onClick={() => refresh().catch(() => {})}
          disabled={loading}
          title="Обновить изменения"
          aria-label="Обновить изменения"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
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
            <div className="text-sm font-medium text-foreground">Всё чисто</div>
            <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
              Когда агент изменит файлы, они появятся здесь автоматически.
            </p>
          </div>
        ) : (
          <div className="space-y-1">
            {files.map((file) => (
              <button
                key={`${file.status}:${file.path}`}
                type="button"
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition hover:bg-accent/60"
                onClick={() => requestOpenFile(file.path)}
                title={`Открыть ${file.path}`}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-card font-mono text-[11px] font-semibold text-muted-foreground">
                  {statusMark(file.status)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs text-foreground/90">
                    {file.path}
                  </span>
                  <span className="mt-0.5 block text-[10.5px] text-muted-foreground">
                    {statusLabel(file.status)} · открыть в файлах
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
