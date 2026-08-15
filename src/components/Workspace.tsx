import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// I-34: открытый Workspace обновляется по файловым событиям/завершённым
// mutating tools, а polling остаётся только резервным механизмом.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { api, workspaceDownloadUrl } from "../api/client";
import { useStore } from "../store/useStore";
import {
  CloseIcon,
  FilePlusIcon,
  FolderPlusIcon,
  FolderUploadIcon,
  RefreshIcon,
  SearchIcon,
} from "./icons";
import FileEditor from "./workspace/FileEditor";
import {
  editability,
  keepViewMode,
  previewKind,
  type ViewMode,
  viewModesFor,
  workspacePreviewUrl,
} from "./workspace/fileDecisions";
import {
  editorAfterRename,
  editorClosedByDelete,
  panelButtonGate,
  renamePlan,
  uploadBatches,
  uploadPercent as uploadPercentOf,
  workspaceOperable,
} from "./workspace/fileOperations";
import {
  acceptsResult,
  errorDisposition,
  nextGeneration,
  POLL_INTERVAL_MS,
  shouldPoll,
} from "./workspace/syncDecisions";
import WorkspaceTree from "./workspace/WorkspaceTree";
import {
  DEEP_RELOAD_MAX_DEPTH,
  filterNodes as filterTreeNodes,
  STATUS_COLORS,
  type TreeNode,
  toRelPath,
  toTree,
} from "./workspace/workspaceTreeHelpers";

function statusColor(status?: string): string {
  return STATUS_COLORS[status ?? ""] || "var(--color-muted-foreground)";
}

// Этап 3.1: решения о файле — правится ли, чем показывается, куда ведёт
// превью — вынесены в `./workspace/fileDecisions.ts` и проверяются там
// перебором. Здесь они жили приватными функциями внутри файла в 1111 строк,
// который не поднимается ни одним тестом: чистыми они были и тогда,
// проверяемыми — нет.
function isEditablePath(path: string): boolean {
  return editability(path).editable;
}

/** Двоичное содержимое редактировать нельзя — сохранение испортило бы файл. */
function looksBinary(content: string): boolean {
  return !editability("", content).editable;
}

export default function Workspace() {
  const workspaceOpen = useStore((s) => s.workspaceOpen);
  const setWorkspaceOpen = useStore((s) => s.setWorkspaceOpen);
  const currentID = useStore((s) => s.currentID);
  const workspaceRevision = useStore((s) =>
    currentID ? (s.workspaceRevision[currentID] ?? 0) : 0,
  );
  const pendingOpenFile = useStore((s) => s.pendingOpenFile);
  const clearPendingOpenFile = useStore((s) => s.clearPendingOpenFile);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set([""]));
  const expandedRef = useRef<Set<string>>(expanded);
  const [activeFile, setActiveFile] = useState<{
    path: string;
    content: string;
  } | null>(null);
  // Черновик редактора живёт отдельно от загруженного содержимого: их
  // расхождение и есть признак несохранённых правок.
  const [draft, setDraft] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>("code");
  const [saving, setSaving] = useState(false);
  const [createKind, setCreateKind] = useState<"file" | "directory" | null>(
    null,
  );
  const [createPath, setCreatePath] = useState("");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [filter, setFilter] = useState("");
  const [gitFiles, setGitFiles] = useState<{ path: string; status?: string }[]>(
    [],
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const loadingDirs = useRef<Set<string>>(new Set());
  const loadGen = useRef(0);

  // Every chat owns exactly one real workspace. No synthetic project tree or
  // privileged self-editing path is injected into ordinary sessions.
  const withWorkspaceRoot = useCallback((nodes: TreeNode[]) => nodes, []);

  const sessions = useStore((s) => s.sessions);
  const mySessionIds = useMemo(
    () => new Set(sessions.map((s) => s.id)),
    [sessions],
  );
  const filterNodes = useCallback(
    (nodes: { path: string; type?: string; isDirectory?: boolean }[]) =>
      filterTreeNodes(nodes, { mySessionIds }),
    [mySessionIds],
  );

  const loadDir = useCallback(
    async (path: string) => {
      if (!workspaceOperable(currentID)) return [];
      try {
        const nodes = await api.listDir(path, currentID);
        let tree = Array.isArray(nodes)
          ? toTree(
              filterNodes(nodes) as {
                path: string;
                type?: string;
                isDirectory?: boolean;
              }[],
            )
          : [];
        // Сервер возвращает пути от корня workspace — спускаемся до запрошенной
        // папки, чтобы не дублировать её как собственного ребёнка (checkers/checkers/…).
        if (path && path !== ".") {
          for (const seg of path.split("/").filter(Boolean)) {
            const next = tree.find((n) => n.name === seg && n.isDir);
            if (!next) break; // пути уже относительные — отдаём как есть
            tree = next.children ?? [];
          }
        }
        return tree;
      } catch (e: unknown) {
        throw e instanceof Error ? e : new Error(String(e));
      }
    },
    [currentID, filterNodes],
  );

  // Полная перезагрузка видимой части дерева: корень + рекурсивно содержимое
  // всех РАСКРЫТЫХ папок (включая раскрытые каталоги текущего workspace). Свёрнутые папки
  // остаются loaded:false и подгружаются заново при раскрытии — это осознанно:
  // при раскрытии пользователь получает свежие данные, а не кэш.
  // Раньше autoRefresh переиспользовал oldNode.children для раскрытых папок,
  // из-за чего файлы, созданные агентом внутри открытой папки, не появлялись
  // никогда; а refresh() сбрасывал дерево до корня, и раскрытые папки
  // выглядели пустыми до повторного клика.
  // Старый обход N+1 запросами /file — теперь только fallback на случай,
  // если сервер ещё без эндпоинта /workspace/tree (старый деплой).
  const loadTreeDeepViaListDir = useCallback(async (): Promise<TreeNode[]> => {
    const rootNodes = await loadDir(".");
    const expandedPaths = expandedRef.current;
    const fill = async (
      nodes: TreeNode[],
      depth: number,
    ): Promise<TreeNode[]> =>
      Promise.all(
        nodes.map(async (n) => {
          if (
            !n.isDir ||
            !expandedPaths.has(n.path) ||
            depth >= DEEP_RELOAD_MAX_DEPTH
          )
            return n;
          try {
            const children = await fill(await loadDir(n.path), depth + 1);
            return { ...n, children, loaded: true };
          } catch {
            return n; // ошибка одной папки не валит всё дерево
          }
        }),
      );
    return fill(withWorkspaceRoot(rootNodes), 0);
  }, [loadDir, withWorkspaceRoot]);

  // Релиз 3: один рекурсивный запрос к серверу вместо N+1 listDir по
  // раскрытым папкам. Все папки приходят с полным содержимым — помечаем
  // их loaded, чтобы toggleDir не делал лишний догружающий запрос.
  const loadTreeDeep = useCallback(async (): Promise<TreeNode[]> => {
    if (!workspaceOperable(currentID)) return [];
    try {
      const nodes = await api.listTree(currentID);
      if (!Array.isArray(nodes)) throw new Error("bad tree response");
      const markLoaded = (ns: TreeNode[]): TreeNode[] =>
        ns.map((n) =>
          n.isDir
            ? { ...n, loaded: true, children: markLoaded(n.children ?? []) }
            : n,
        );
      const tree = markLoaded(
        toTree(
          filterNodes(nodes) as {
            path: string;
            type?: string;
            isDirectory?: boolean;
          }[],
        ),
      );
      return withWorkspaceRoot(tree);
    } catch {
      return loadTreeDeepViaListDir();
    }
  }, [currentID, filterNodes, withWorkspaceRoot, loadTreeDeepViaListDir]);

  const refresh = useCallback(async () => {
    if (!workspaceOperable(currentID)) {
      setTree([]);
      setLoading(false);
      setError(null);
      return;
    }
    const gen = nextGeneration(loadGen.current, "manual");
    loadGen.current = gen;
    setLoading(true);
    setError(null);
    try {
      const t = await loadTreeDeep();
      if (!acceptsResult(gen, loadGen.current)) return;
      setTree(t);
    } catch (e: unknown) {
      if (!acceptsResult(gen, loadGen.current)) return;
      if (errorDisposition("manual") === "show") {
        setError((e as Error)?.message || "Не удалось загрузить файлы");
        setTree(withWorkspaceRoot([]));
      }
    } finally {
      if (acceptsResult(gen, loadGen.current)) setLoading(false);
    }
  }, [currentID, loadTreeDeep, withWorkspaceRoot]);

  const autoRefresh = useCallback(async () => {
    if (!workspaceOperable(currentID)) return;
    // Не бампаем loadGen (фоновый опрос не должен инвалидировать ручной
    // refresh), но запоминаем текущее значение: если за время запроса
    // сменилась сессия или прошёл ручной refresh — молча выбрасываем результат,
    // иначе setTree записал бы дерево чужой/устаревшей сессии.
    const gen = nextGeneration(loadGen.current, "background");
    try {
      const t = await loadTreeDeep();
      if (!acceptsResult(gen, loadGen.current)) return;
      setTree(t);
    } catch {
      // errorDisposition("background") === "swallow": дерево на экране всё ещё
      // верное, и красная плашка сообщила бы о поломке, которой пользователь
      // иначе не заметил бы.
    }
  }, [currentID, loadTreeDeep]);

  const loadGit = useCallback(async () => {
    if (!workspaceOperable(currentID)) {
      setGitFiles([]);
      return;
    }
    try {
      const files = await api.gitStatus(currentID);
      const list = Array.isArray(files)
        ? (files as { path: string; status?: string }[])
        : [];
      setGitFiles(filterNodes(list));
    } catch {
      setGitFiles([]);
    }
  }, [currentID, filterNodes]);

  useEffect(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    input.setAttribute("mozdirectory", "");
    input.style.display = "none";
    document.body.appendChild(input);
    folderInputRef.current = input;
    return () => {
      input.remove();
      folderInputRef.current = null;
    };
  }, []);

  // bind upload handler
  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) return;
    const handler = async (e: Event) => {
      const el = e.target as HTMLInputElement;
      const fileList = el.files;
      if (!fileList || fileList.length === 0) return;
      const files: { path: string; file: File }[] = [];
      for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];
        if (!file) continue;
        const relPath =
          (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
          file.name;
        files.push({ path: relPath, file });
      }
      setUploading(true);
      setUploadTotal(files.length);
      setUploadProgress(0);
      setUploadMsg(`Загрузка ${files.length} файлов…`);
      try {
        let done = 0;
        for (const batch of uploadBatches(files, 20)) {
          if (!currentID) throw new Error("Нет активного workspace");
          await api.uploadFolder(batch, currentID);
          done += batch.length;
          setUploadProgress(done);
        }
        setUploadMsg(`Загружено файлов: ${files.length}`);
        refresh().catch(() => {});
        setTimeout(() => setUploadMsg(null), 3000);
      } catch (err: unknown) {
        setUploadMsg(`Ошибка: ${(err as Error).message}`);
        setTimeout(() => setUploadMsg(null), 5000);
      } finally {
        setUploading(false);
        el.value = "";
      }
    };
    input.addEventListener("change", handler);
    return () => input.removeEventListener("change", handler);
  }, [refresh]);

  expandedRef.current = expanded;

  useEffect(() => {
    if (!workspaceOpen || !workspaceOperable(currentID)) return;
    refresh().catch(() => {});
    loadGit().catch(() => {});
    // Условие опроса — одно на таймер и на возврат к вкладке. Два условия
    // одного смысла разошлись бы молча: скрытая вкладка перестала бы
    // опрашивать по таймеру, но опрашивала бы по событию видимости.
    const pollNow = () => {
      if (
        !shouldPoll({
          panelOpen: workspaceOpen,
          documentHidden: document.hidden,
          sessionReady: workspaceOperable(currentID),
        })
      ) {
        return;
      }
      autoRefresh().catch(() => {});
      loadGit().catch(() => {});
    };
    const poll = setInterval(pollNow, POLL_INTERVAL_MS);
    // Вернулись на вкладку — сразу освежаем, не дожидаясь тика таймера.
    const onVisibility = () => {
      pollNow();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [workspaceOpen, currentID, refresh, loadGit, autoRefresh]);

  // Событийная синхронизация поверх polling: native runtime публикует
  // изменения файлов, а завершившиеся bash/write/edit tool-parts бампают revision.
  // Дебаунс схлопывает `scp -r`/`rsync`, которые могут породить сотни событий,
  // в одно перечитывание дерева. Polling остаётся страховкой на случай, если
  // файловый watcher ОС временно пропустил событие.
  useEffect(() => {
    if (
      !workspaceOpen ||
      !workspaceOperable(currentID) ||
      workspaceRevision <= 0
    ) {
      return;
    }
    const timer = setTimeout(() => {
      autoRefresh().catch(() => {});
      loadGit().catch(() => {});
    }, 250);
    return () => clearTimeout(timer);
  }, [
    workspaceOpen,
    currentID,
    workspaceRevision,
    autoRefresh,
    loadGit,
  ]);

  // Смена чата = другой изолированный воркспейс. Открытый редактор обязательно
  // закрываем: сохранение берёт currentID на момент записи, поэтому файл,
  // открытый в прошлом чате, ушёл бы в воркспейс нового.
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentID здесь — триггер сброса, а не читаемое значение; убрать его из списка значит отработать один раз при монтировании и оставить дерево прошлого чата на экране
  useEffect(() => {
    setExpanded(new Set([""]));
    setActiveFile(null);
    setDraft("");
    setCreateKind(null);
    setCreatePath("");
    setRenamingPath(null);
    setTree([]);
  }, [currentID]);

  const toggleDir = async (node: TreeNode) => {
    const next = new Set(expanded);
    expandedRef.current = next;
    if (next.has(node.path)) {
      next.delete(node.path);
    } else {
      next.add(node.path);
      if (!node.loaded && !loadingDirs.current.has(node.path)) {
        loadingDirs.current.add(node.path);
        try {
          const children = await loadDir(node.path);
          const update = (nodes: TreeNode[]): TreeNode[] =>
            nodes.map((n) => {
              if (n.path === node.path) return { ...n, children, loaded: true };
              if (n.children) return { ...n, children: update(n.children) };
              return n;
            });
          setTree((prev) => update(prev));
        } finally {
          loadingDirs.current.delete(node.path);
        }
      }
    }
    setExpanded(next);
  };

  const openFile = useCallback(
    async (path: string) => {
      try {
        const res = await api.readFile(path, currentID);
        const content = res.content ?? res.text ?? "";
        setActiveFile({ path, content });
        setDraft(content);
        // Превью по умолчанию для того, что имеет смысл смотреть, а не читать:
        // содержимое картинки как текст — просто мусор на экране.
        setViewMode(previewKind(path) === "image" ? "preview" : "code");
      } catch (e: unknown) {
        toast("error", (e as Error)?.message || "Не удалось открыть файл");
      }
    },
    [currentID],
  );

  // Клик по пути файла в чате (см. uiSlice.requestOpenFile). Команда
  // одноразовая: сбрасываем её сразу, иначе повторный клик по тому же пути
  // не вызвал бы повторного открытия.
  useEffect(() => {
    if (!pendingOpenFile) return;
    clearPendingOpenFile();
    if (!workspaceOperable(currentID)) return;
    openFile(pendingOpenFile).catch(() => {});
  }, [pendingOpenFile, clearPendingOpenFile, currentID, openFile]);

  const dirty = activeFile !== null && draft !== activeFile.content;
  const activeEditable =
    activeFile !== null &&
    isEditablePath(activeFile.path) &&
    !looksBinary(activeFile.content);
  const activePreviewKind = activeFile ? previewKind(activeFile.path) : null;
  const activeModes = activeFile
    ? viewModesFor(activeFile.path, { hasDiff: dirty })
    : [];
  // Режим зажимается набором: сохранение убирает вкладку «Изменения», и
  // оставленный на ней редактор показывал бы пустоту вместо файла.
  const activeMode = keepViewMode(viewMode, activeModes);
  // Причина «только чтение». Условие берётся из `editability`, а не считается
  // здесь заново; тексты пока прежние — они длиннее и мягче тех, что лежат в
  // `fileDecisions`, а сведение двух формулировок в одну видно пользователю и
  // требует согласования.
  const readonlyNote =
    activeFile &&
    editability(activeFile.path, activeFile.content).reason === "binary"
      ? "Двоичный файл — доступен только просмотр."
      : "Этот тип файла доступен только для просмотра.";
  const uploadPercent = uploadPercentOf(uploadProgress, uploadTotal);
  // Один шлюз на все операции с файлами. Прежде это условие было выписано
  // заново в каждом обработчике и в `disabled` каждой кнопки — и всюду молча.
  /**
   * Свойства кнопки панели. Правило — в `panelButtonGate`, там же оно и
   * проверяется: внутри компонента его видел бы только рендер.
   */
  const opGate = (fallbackTitle: string, busy?: boolean, busyTitle?: string) =>
    panelButtonGate({
      sessionId: currentID,
      fallbackTitle,
      ...(busy === undefined ? {} : { busy }),
      ...(busyTitle === undefined ? {} : { busyTitle }),
    });

  const closeActiveFile = useCallback(() => {
    if (dirty && !confirm("Закрыть файл и потерять несохранённые правки?")) {
      return;
    }
    setActiveFile(null);
    setDraft("");
  }, [dirty]);

  const saveActiveFile = useCallback(async () => {
    if (!activeFile || !workspaceOperable(currentID)) return;
    if (!isEditablePath(activeFile.path)) return;
    setSaving(true);
    try {
      await api.writeFile(activeFile.path, draft, currentID);
      // Сохранённый черновик становится новым эталоном, иначе файл остался бы
      // помеченным как изменённый сразу после успешной записи.
      setActiveFile({ path: activeFile.path, content: draft });
      toast("success", `Сохранено: ${toRelPath(activeFile.path)}`);
      loadGit().catch(() => {});
      autoRefresh().catch(() => {});
    } catch (e: unknown) {
      toast("error", (e as Error)?.message || "Не удалось сохранить файл");
    } finally {
      setSaving(false);
    }
  }, [activeFile, currentID, draft, loadGit, autoRefresh]);

  // Ctrl/Cmd+S внутри открытого файла — сохранение вместо диалога браузера.
  useEffect(() => {
    if (!activeFile || !activeEditable) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveActiveFile().catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeFile, activeEditable, saveActiveFile]);

  const submitCreate = async () => {
    const path = createPath.trim();
    if (!path || !workspaceOperable(currentID)) return;
    const kind = createKind ?? "file";
    try {
      await api.createFile(path, currentID, kind);
      setCreateKind(null);
      setCreatePath("");
      toast(
        "success",
        kind === "directory"
          ? `Папка создана: ${path}`
          : `Файл создан: ${path}`,
      );
      await refresh();
      if (kind === "file") await openFile(path);
    } catch (e: unknown) {
      toast("error", (e as Error)?.message || "Не удалось создать");
    }
  };

  const submitRename = async (fromPath: string) => {
    const name = renameValue.trim();
    setRenamingPath(null);
    if (!workspaceOperable(currentID)) return;
    const plan = renamePlan(fromPath, renameValue);
    if (plan.kind === "noop") return;
    const to = plan.to;
    try {
      await api.renameFile(fromPath, to, currentID);
      // Открытый файл переехал — иначе редактор сохранял бы по старому пути.
      // Переименование ПАПКИ уводит за собой и файл внутри неё: прежнее
      // условие сравнивало пути целиком, и следующее сохранение воссоздавало
      // папку, которую пользователь только что переименовал.
      setActiveFile((prev) => {
        const next = editorAfterRename(prev?.path, fromPath, to);
        return prev && next ? { ...prev, path: next } : prev;
      });
      toast("success", `Переименовано в ${name}`);
      await refresh();
      loadGit().catch(() => {});
    } catch (e: unknown) {
      toast("error", (e as Error)?.message || "Не удалось переименовать");
    }
  };

  const deleteItem = async (node: TreeNode) => {
    if (!workspaceOperable(currentID)) return;
    const what = node.isDir ? "папку" : "файл";
    if (!confirm(`Удалить ${what} ${toRelPath(node.path)}?`)) return;
    try {
      await api.deleteFile(node.path, currentID);
      // Удалённая папка уносит и открытый внутри неё файл: сохранять его
      // некуда, а запись по прежнему пути воссоздала бы удалённое.
      if (editorClosedByDelete(activeFile?.path, node.path)) {
        setActiveFile(null);
        setDraft("");
      }
      toast("success", `Удалено: ${toRelPath(node.path)}`);
      await refresh();
      loadGit().catch(() => {});
    } catch (e: unknown) {
      toast("error", (e as Error)?.message || "Не удалось удалить");
    }
  };

  const downloadWorkspaceItem = (path: string) => {
    // Без сессии роут отвечает 400 Missing sessionId, и браузер сохранил бы
    // JSON с ошибкой вместо файла. URL собирает общий билдер: вторая копия
    // правила разошлась бы с той, по которой работают файл-чипы в переписке.
    if (!workspaceOperable(currentID)) return;
    const url = workspaceDownloadUrl(path, currentID);
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  if (!workspaceOpen) return null;

  return (
    <>
      {activeFile && (
        <FileEditor
          file={activeFile}
          draft={draft}
          dirty={dirty}
          editable={activeEditable}
          saving={saving}
          modes={activeModes}
          mode={activeMode}
          previewKind={activePreviewKind}
          previewUrl={
            activePreviewKind && currentID
              ? workspacePreviewUrl(activeFile.path, currentID)
              : null
          }
          sessionId={currentID}
          readonlyNote={readonlyNote}
          onModeChange={setViewMode}
          onDraftChange={setDraft}
          onSave={() => {
            saveActiveFile().catch(() => {});
          }}
          onClose={closeActiveFile}
        />
      )}

      <aside
        className={cn(
          "z-50 flex flex-col border border-border bg-background text-foreground min-h-0",
          // Mobile: fills the sliding right sidebar drawer perfectly without overflowing.
          // Desktop: fixed maximum size window inside the right sidebar, height strictly clamped so ScrollArea scrolls.
          "w-full h-full max-h-full shadow-lg md:static md:my-2 md:mx-2 md:h-[calc(100%-1rem)] md:max-h-[calc(100%-1rem)] md:w-[calc(100%-1rem)] md:max-w-[calc(100%-1rem)] md:shrink-0 md:rounded-2xl md:overflow-hidden md:shadow-none",
        )}
      >
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3 safe-top">
          <div className="flex gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {/* `text-white`, а не тон темы, здесь означало «невидимо в
                светлой теме»: заголовок панели рисовался белым по почти
                белому. */}
            <span className="text-foreground">Files</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => {
                setCreateKind("file");
                setCreatePath("");
              }}
              {...opGate("Новый файл")}
              aria-label="Новый файл"
            >
              <FilePlusIcon size={15} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => {
                setCreateKind("directory");
                setCreatePath("");
              }}
              {...opGate("Новая папка")}
              aria-label="Новая папка"
            >
              <FolderPlusIcon size={15} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => folderInputRef.current?.click()}
              {...opGate("Загрузить папку", uploading, "Идёт загрузка…")}
              aria-label="Загрузить папку"
            >
              <FolderUploadIcon size={15} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => {
                refresh().catch(() => {});
              }}
              title="Обновить"
              aria-label="Обновить"
              disabled={loading}
            >
              <RefreshIcon size={15} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
              onClick={() => setWorkspaceOpen(false)}
              title="Закрыть файлы проекта"
              aria-label="Закрыть файлы проекта"
            >
              <CloseIcon size={15} />
            </Button>
          </div>
        </header>

        <div className="border-b border-border px-2.5 py-2 shrink-0">
          <div className="relative">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
              <SearchIcon size={14} />
            </span>
            <Input
              className="h-8 rounded-lg border-border bg-card pl-8 text-[11px] text-foreground placeholder:text-muted-foreground"
              placeholder="Фильтр файлов…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
        </div>

        {(uploading || uploadMsg) && (
          <div
            className="space-y-1.5 border-b border-border px-2.5 py-2 shrink-0"
            aria-live="polite"
          >
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">{uploadMsg}</span>
              {uploading && uploadTotal > 0 && (
                <span className="shrink-0 tabular-nums">
                  {uploadProgress}/{uploadTotal}
                </span>
              )}
            </div>
            {uploading && (
              <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${uploadPercent}%` }}
                />
              </div>
            )}
          </div>
        )}

        {createKind && (
          <div className="border-b border-border px-2.5 py-2 shrink-0">
            <Input
              autoFocus
              className="h-8 rounded-lg border-border bg-card font-mono text-[11px]"
              placeholder={
                createKind === "directory" ? "src/components" : "src/index.ts"
              }
              value={createPath}
              onChange={(e) => setCreatePath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitCreate().catch(() => {});
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setCreateKind(null);
                }
              }}
            />
            <p className="mt-1 px-0.5 text-[10px] text-muted-foreground">
              Путь от корня workspace. Enter — создать, Esc — отмена.
            </p>
          </div>
        )}

        {gitFiles.length > 0 && (
          <div className="border-b border-border px-3 pb-2 shrink-0">
            <div className="mb-1 flex items-center gap-2 py-1 text-xs text-muted-foreground">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              {gitFiles.length} changed{" "}
              {gitFiles.length === 1 ? "file" : "files"}
            </div>
            <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
              {gitFiles.slice(0, 8).map((f) => (
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs hover:bg-muted"
                  key={f.path}
                  onClick={() => openFile(f.path).catch(() => {})}
                  title={toRelPath(f.path)}
                >
                  <span
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white"
                    style={{
                      background: statusColor(f.status),
                    }}
                  >
                    {(f.status ?? "?").charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 truncate text-muted-foreground">
                    {toRelPath(f.path)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <ScrollArea className="flex-1 min-h-0 w-full">
          <div className="px-2 py-2 pb-8">
            {!currentID ? (
              <p className="px-2 py-3 text-xs text-muted-foreground">
                Выберите или создайте чат, чтобы увидеть workspace.
              </p>
            ) : (
              <>
                {loading && tree.length === 0 && (
                  <div className="px-2 py-6 text-center">
                    <div className="mx-auto mb-2 h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-primary" />
                    <p className="text-xs text-muted-foreground">
                      Загрузка файлов…
                    </p>
                  </div>
                )}
                {error && (
                  <div className="mx-1 mb-2 space-y-2 rounded-lg border border-red-500/30 bg-red-500/10 px-2 py-2 text-xs text-red-400">
                    <div>
                      {typeof error === "string"
                        ? error
                        : JSON.stringify(error)}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => {
                        refresh().catch(() => {});
                      }}
                    >
                      Повторить
                    </Button>
                  </div>
                )}
                {!loading && tree.length === 0 && !error && (
                  <div className="px-2 py-4 text-xs text-muted-foreground space-y-2">
                    <p>Файлов пока нет в workspace этого чата.</p>
                    <p className="text-[11px] opacity-80">
                      Создайте файл кнопкой выше, загрузите папку или попросите
                      агента.
                    </p>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8"
                      onClick={() => {
                        refresh().catch(() => {});
                      }}
                    >
                      Обновить
                    </Button>
                  </div>
                )}
                <WorkspaceTree
                  nodes={tree}
                  filter={filter}
                  expanded={expanded}
                  gitFiles={gitFiles}
                  activeFilePath={activeFile?.path ?? null}
                  renamingPath={renamingPath}
                  renameValue={renameValue}
                  setRenameValue={setRenameValue}
                  setRenamingPath={setRenamingPath}
                  submitRename={submitRename}
                  toggleDir={toggleDir}
                  openFile={openFile}
                  deleteItem={deleteItem}
                  downloadWorkspaceItem={downloadWorkspaceItem}
                />
              </>
            )}
          </div>
        </ScrollArea>
      </aside>
    </>
  );
}
