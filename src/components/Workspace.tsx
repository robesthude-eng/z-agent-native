import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// I-34: открытый Workspace обновляется по файловым событиям/завершённым
// mutating tools, а polling остаётся только резервным механизмом.
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { changedFilesLabel, t, tf } from "@/i18n";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { api, workspaceDownloadUrl } from "../api/client";
import { usePreviewUrl } from "../api/previewUrl";
import { useStore } from "../store/useStore";
import {
  CloseIcon,
  FilePlusIcon,
  FolderPlusIcon,
  FolderUploadIcon,
  GitBranchIcon,
  RefreshIcon,
  SearchIcon,
  WarningIcon,
  WorkspaceOpenIcon,
} from "./icons";
import FileEditor from "./workspace/FileEditor";
import {
  editability,
  keepViewMode,
  previewKind,
  type ViewMode,
  viewModesFor,
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

/**
 * Ширины полос скелета загрузки. Разные намеренно: одинаковые читаются
 * как таблица, а не как список файлов.
 */
const SKELETON_ROWS = [128, 96, 148, 84, 116, 72];

/**
 * Оставит ли фильтр хоть одну строку на экране.
 *
 * Без этой проверки промах в фильтре выглядел как сломавшаяся панель:
 * дерево просто исчезало, и ничто не говорило, что виновато набранное слово.
 */
function hasVisibleMatch(nodes: TreeNode[], filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  const walk = (list: TreeNode[]): boolean =>
    list.some(
      (n) =>
        n.path.toLowerCase().includes(needle) ||
        (n.children ? walk(n.children) : false),
    );
  return walk(nodes);
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
  const askConfirm = useConfirm();
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
        setError((e as Error)?.message || t("workspace.ne_udalos_zagruzit_fayly"));
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
      const uploadSessionId = currentID;
      if (!workspaceOperable(uploadSessionId)) {
        setUploadMsg(t("workspace.oshibka_net_aktivnogo_workspace"));
        el.value = "";
        return;
      }
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
      setUploadMsg(tf("workspace.zagruzka_0_faylov", [files.length]));
      try {
        let done = 0;
        for (const batch of uploadBatches(files, 20)) {
          const result = await api.uploadFolder(batch, uploadSessionId);
          done += result.written;
          setUploadProgress(done);
          if (!result.ok) {
            const detail = result.errors?.slice(0, 3).join("; ");
            throw new Error(
              detail ||
                tf("workspace.server_zapisal_0_iz_1_faylov", [result.written, batch.length]),
            );
          }
        }
        setUploadMsg(tf("workspace.zagruzheno_faylov_0", [files.length]));
        if (useStore.getState().currentID === uploadSessionId) {
          refresh().catch(() => {});
        }
        setTimeout(() => setUploadMsg(null), 3000);
      } catch (err: unknown) {
        setUploadMsg(tf("workspace.oshibka_0", [(err as Error).message]));
        setTimeout(() => setUploadMsg(null), 5000);
      } finally {
        setUploading(false);
        el.value = "";
      }
    };
    input.addEventListener("change", handler);
    return () => input.removeEventListener("change", handler);
  }, [refresh, currentID]);

  expandedRef.current = expanded;

  useEffect(() => {
    if (!workspaceOpen || !workspaceOperable(currentID)) return;
    refresh().catch(() => {});
    loadGit().catch(() => {});
    // Условие опроса — одно на ��аймер и на возврат к вкладке. Два условия
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
        toast("error", (e as Error)?.message || t("workspace.ne_udalos_otkryt_fayl"));
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
  // Тот же маркер доступа, что и у панели превью: без него соседние файлы
  // страницы (style.css, script.js) в песочнице получают 404.
  const activePreviewUrl = usePreviewUrl(
    currentID || "",
    activeFile?.path ?? "",
    Boolean(activePreviewKind && currentID),
  );
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
      ? t("workspace.dvoichnyy_fayl_dostupen_tolko_prosmotr")
      : t("workspace.etot_tip_fayla_dostupen_tolko_dlya");
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

  const closeActiveFile = useCallback(async () => {
    if (dirty) {
      const ok = await askConfirm({
        title: t("workspace.zakryt_fayl"),
        description: t("workspace.nesohranennye_pravki_budut_poteryany"),
        confirmLabel: t("workspace.zakryt_bez_sohraneniya"),
        destructive: true,
      });
      if (!ok) return;
    }
    setActiveFile(null);
    setDraft("");
  }, [dirty, askConfirm]);

  const saveActiveFile = useCallback(async () => {
    if (!activeFile || !workspaceOperable(currentID)) return;
    if (!isEditablePath(activeFile.path)) return;
    setSaving(true);
    try {
      await api.writeFile(activeFile.path, draft, currentID);
      // Сохранённый черновик становится новым эталоном, иначе файл остался бы
      // помеченным как изменённый сразу после успешной записи.
      setActiveFile({ path: activeFile.path, content: draft });
      toast("success", tf("workspace.sohraneno_0", [toRelPath(activeFile.path)]));
      loadGit().catch(() => {});
      autoRefresh().catch(() => {});
    } catch (e: unknown) {
      toast("error", (e as Error)?.message || t("workspace.ne_udalos_sohranit_fayl"));
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
          ? tf("workspace.papka_sozdana_0", [path])
          : tf("workspace.fayl_sozdan_0", [path]),
      );
      await refresh();
      if (kind === "file") await openFile(path);
    } catch (e: unknown) {
      toast("error", (e as Error)?.message || t("workspace.ne_udalos_sozdat"));
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
      toast("success", tf("workspace.pereimenovano_v_0", [name]));
      await refresh();
      loadGit().catch(() => {});
    } catch (e: unknown) {
      toast("error", (e as Error)?.message || t("workspace.ne_udalos_pereimenovat"));
    }
  };

  const deleteItem = async (node: TreeNode) => {
    if (!workspaceOperable(currentID)) return;
    const what = node.isDir ? t("workspace.papku") : t("message_item.fayl");
    const ok = await askConfirm({
      title: tf("workspace.udalit_0", [what]),
      description: tf("workspace.put_0_budet_udalen_bez_vozmozhnosti", [toRelPath(node.path)]),
      confirmLabel: t("workspace.udalit"),
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteFile(node.path, currentID);
      // Удалённая папка уносит и открытый внутри неё файл: сохранять его
      // некуда, а запись по прежнему пути воссоздала бы удалённое.
      if (editorClosedByDelete(activeFile?.path, node.path)) {
        setActiveFile(null);
        setDraft("");
      }
      toast("success", tf("workspace.udaleno_0", [toRelPath(node.path)]));
      await refresh();
      loadGit().catch(() => {});
    } catch (e: unknown) {
      toast("error", (e as Error)?.message || t("workspace.ne_udalos_udalit"));
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
          previewUrl={activePreviewKind && currentID ? activePreviewUrl : null}
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
          // `bg-card`, а не `bg-background`: панель лежит на том же фоне,
          // что и приложение, и без собственного тона её граница держалась
          // только на тонкой линии border.
          "z-50 flex flex-col border border-border bg-card text-foreground min-h-0",
          // Mobile: fills the sliding right sidebar drawer perfectly without overflowing.
          // Desktop: fixed maximum size window inside the right sidebar, height strictly clamped so ScrollArea scrolls.
          "w-full h-full max-h-full shadow-lg md:static md:my-2 md:mx-2 md:h-[calc(100%-1rem)] md:max-h-[calc(100%-1rem)] md:w-[calc(100%-1rem)] md:max-w-[calc(100%-1rem)] md:shrink-0 md:rounded-2xl md:overflow-hidden md:shadow-none",
        )}
      >
        <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-3 safe-top">
          <div className="flex min-w-0 items-center gap-2">
            {/* `text-white`, а не тон темы, здесь означало «невидимо в
                светлой теме»: заголовок панели рисовался белым по почти
                белому. */}
            <span className="shrink-0 text-muted-foreground">
              <WorkspaceOpenIcon size={15} />
            </span>
            <span className="truncate text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">
              {t("workspace.files")}
            </span>
            {tree.length > 0 && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] leading-none tabular-nums text-muted-foreground">
                {tree.length}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => {
                setCreateKind("file");
                setCreatePath("");
              }}
              {...opGate(t("workspace.novyy_fayl"))}
              aria-label={t("workspace.novyy_fayl")}
            >
              <FilePlusIcon size={15} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => {
                setCreateKind("directory");
                setCreatePath("");
              }}
              {...opGate(t("sidebar.novaya_papka"))}
              aria-label={t("sidebar.novaya_papka")}
            >
              <FolderPlusIcon size={15} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => folderInputRef.current?.click()}
              {...opGate(t("workspace.zagruzit_papku"), uploading, t("workspace.idet_zagruzka"))}
              aria-label={t("workspace.zagruzit_papku")}
            >
              <FolderUploadIcon size={15} />
            </Button>
            {/* Разделитель: слева — создание и загрузка, справа — действия
                самой панели. Пять одинаковых квадратов подряд читались как один
                список без приоритета. */}
            <span
              aria-hidden="true"
              className="mx-0.5 h-4 w-px shrink-0 bg-border"
            />
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={() => {
                refresh().catch(() => {});
              }}
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
              onClick={() => setWorkspaceOpen(false)}
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
              onChange={(e) => setFilter(e.target.value)}
            />
            {/* Крестик очистки: набранный фильтр прячет остальное дерево,
                а убрать его можно было только вручную, по символу. */}
            {filter && (
              <button
                type="button"
                onClick={() => setFilter("")}
                className="absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                title={t("workspace.ochistit_filtr")}
                aria-label={t("workspace.ochistit_filtr")}
              >
                <CloseIcon size={12} />
              </button>
            )}
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
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all duration-200"
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
            <p className="mt-1.5 px-0.5 text-[10.5px] leading-relaxed text-muted-foreground">
              {t("workspace.put_ot_kornya_workspace_enter_sozdat")}
            </p>
          </div>
        )}

        {gitFiles.length > 0 && (
          <div className="shrink-0 border-b border-border px-2.5 pb-2">
            <div className="mb-0.5 flex items-center gap-1.5 py-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {/* Жёлтая точка говорила «что-то с файлами»; ветка говорит,
                  что речь про git. Кроме того, `bg-amber-400` шло мимо темы:
                  в светлой теме у предупреждений свой тон. */}
              <span className="text-warning">
                <GitBranchIcon size={13} />
              </span>
              {changedFilesLabel(gitFiles.length)}
            </div>
            <div className="flex max-h-40 flex-col gap-0.5 overflow-y-auto">
              {gitFiles.slice(0, 8).map((f) => (
                <button
                  type="button"
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-muted"
                  key={f.path}
                  onClick={() => openFile(f.path).catch(() => {})}
                  title={toRelPath(f.path)}
                >
                  {/* Буква статуса — цветом статуса на его же подложке.
                      Белым по заливке она хуже всего читалась ровно там, где
                      заливка сама светлая — на жёлтом и зелёном. */}
                  <span
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-[10px] font-bold"
                    style={{
                      color: statusColor(f.status),
                      background: `color-mix(in srgb, ${statusColor(f.status)} 18%, transparent)`,
                    }}
                  >
                    {(f.status ?? "?").charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0 truncate font-mono text-muted-foreground">
                    {toRelPath(f.path)}
                  </span>
                </button>
              ))}
              {gitFiles.length > 8 && (
                <span className="px-1.5 pt-0.5 text-[11px] text-muted-foreground/80">
                  {tf("workspace.esche_0", [gitFiles.length - 8])}
                </span>
              )}
            </div>
          </div>
        )}

        <ScrollArea className="flex-1 min-h-0 w-full">
          <div className="px-2 py-2 pb-8">
            {!currentID ? (
              <p className="px-3 py-6 text-center text-xs leading-relaxed text-muted-foreground">
                {t("workspace.vyberite_ili_sozdayte_chat")}
              </p>
            ) : (
              <>
                {loading && tree.length === 0 && (
                  // Скелет вместо крутилки: он занимает ту же высоту, что и
                  // будущие строки, и дерево не прыгает в момент появления.
                  <div
                    className="space-y-1 py-1"
                    aria-busy="true"
                    aria-live="polite"
                  >
                    <span className="sr-only">
                      {t("workspace.zagruzka_faylov")}
                    </span>
                    {SKELETON_ROWS.map((w, i) => (
                      <div
                        key={w}
                        className="flex h-7 items-center gap-2"
                        style={{ paddingLeft: 8 + (i % 3) * 14 }}
                      >
                        <span className="oc-skeleton h-3.5 w-3.5 shrink-0" />
                        <span
                          className="oc-skeleton h-3"
                          style={{ width: w }}
                        />
                      </div>
                    ))}
                  </div>
                )}
                {error && (
                  // Цвета ошибки — токены темы, а не `red-500`/`red-400` мимо неё:
                  // в светлой теме такой текст терял контраст на светлой подложке.
                  <div className="mx-0.5 mb-2 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                    <span className="mt-0.5 shrink-0">
                      <WarningIcon size={14} />
                    </span>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="break-words leading-relaxed">
                        {typeof error === "string"
                          ? error
                          : JSON.stringify(error)}
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-destructive hover:bg-destructive/15 hover:text-destructive"
                        onClick={() => {
                          refresh().catch(() => {});
                        }}
                      >
                        {t("workspace.povtorit")}
                      </Button>
                    </div>
                  </div>
                )}
                {!loading && tree.length === 0 && !error && (
                  // Пустота без значка и без центра читалась как обрезанная
                  // загрузка, а не как нормальное состояние пустого воркспейса.
                  <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                    <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                      <FolderPlusIcon size={18} />
                    </span>
                    <p className="text-xs text-foreground">
                      {t("workspace.faylov_poka_net_v_workspace_etogo")}
                    </p>
                    <p className="max-w-[220px] text-[11px] leading-relaxed text-muted-foreground">
                      {t("workspace.sozdayte_fayl_knopkoy_vyshe_zagruzite")}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-1 h-8 gap-1.5 text-xs"
                      onClick={() => {
                        refresh().catch(() => {});
                      }}
                    >
                      <RefreshIcon size={13} />
                      {t("workspace.obnovit")}
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
                {tree.length > 0 && !hasVisibleMatch(tree, filter) && (
                  <div className="flex flex-col items-center gap-1 px-3 py-8 text-center">
                    <p className="text-xs text-muted-foreground">
                      {t("workspace.nichego_ne_naydeno")}
                    </p>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs"
                      onClick={() => setFilter("")}
                    >
                      {t("workspace.ochistit_filtr")}
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </aside>
    </>
  );
}
