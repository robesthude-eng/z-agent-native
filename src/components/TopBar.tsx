import { lazy, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import {
  CAPABILITY_POLL_MS,
  type CapabilityKind,
  type CapabilityState,
  capabilityGate,
  isCapabilityStateEnabled,
  parseCapabilities,
} from "../api/capabilities";
import { api } from "../api/client";
import { buildChatMarkdown, downloadTextFile } from "../lib/chatText";
import { isTmpSession } from "../lib/ids";
import { useStore } from "../store/useStore";
import {
  BashIcon,
  DownloadIcon,
  MenuIcon,
  PreviewIcon,
  SearchIcon,
  SidebarLeftCollapseIcon,
  SidebarLeftExpandIcon,
  WorkspaceClosedIcon,
  WorkspaceOpenIcon,
} from "./icons";
import { LazyPanel, PanelBodySkeleton } from "./LazyPanel";
import ModelSelector from "./ModelSelector";
import PanelModal from "./PanelModal";

/**
 * Терминал тянет @xterm/xterm с webgl-аддоном и socket.io-client — около
 * 440 КБ, то есть треть всей прежней сборки, ради кнопки, которую на телефоне
 * могут не нажать ни разу. PanelModal возвращает null пока закрыт, поэтому
 * `import()` стартует именно в момент клика по «Терминал», а не на первом
 * рендере. Предпросмотр вынесен по тому же принципу — он тоже открывается
 * только по кнопке.
 */
const Terminal = lazy(() =>
  import("./Terminal").then((m) => ({ default: m.Terminal })),
);
const PreviewPanel = lazy(() =>
  import("./PreviewPanel").then((m) => ({ default: m.PreviewPanel })),
);

export default function TopBar() {
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const workspaceOpen = useStore((s) => s.workspaceOpen);
  const setWorkspaceOpen = useStore((s) => s.setWorkspaceOpen);
  const currentID = useStore((s) => s.currentID);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const sessionReady = !!currentID && !isTmpSession(currentID);

  /**
   * Состояние runtime-возможностей (I-31).
   *
   * `sessionReady` знает только то, что чат не черновик, — про окружение он не
   * знает ничего. Поэтому кнопки открывались вслепую, и о недоступности
   * пользователь узнавал по красной строке внутри уже открытой панели.
   *
   * За флагом `VITE_CAPABILITY_STATE`. Пока он выключен, гейт остаётся прежним:
   * иначе сбой маршрута сделал бы кнопки неактивными там, где раньше они
   * работали.
   */
  const [caps, setCaps] = useState<
    Record<CapabilityKind, CapabilityState | null>
  >({ terminal: null, preview: null, workspace: null });
  const capsFromServer = isCapabilityStateEnabled();

  useEffect(() => {
    if (!capsFromServer || !sessionReady || !currentID) return;
    let alive = true;
    const read = async () => {
      try {
        const next = parseCapabilities(await api.capabilities(currentID));
        if (alive) setCaps(next);
      } catch {
        // Сеть отвалилась — состояние остаётся прежним, а не сбрасывается в
        // «неизвестно»: мигание кнопок при каждой сетевой заминке хуже, чем
        // слегка устаревшее состояние.
      }
    };
    read();
    const timer = setInterval(read, CAPABILITY_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [capsFromServer, sessionReady, currentID]);

  /**
   * Можно ли открывать возможность, и что сказать, если нет.
   *
   * Само правило — в `capabilityGate` (`src/api/capabilities.ts`), там же оно
   * и проверяется: внутри компонента его проверял бы только рендер.
   */
  const gate = (kind: CapabilityKind, fallbackTitle: string) =>
    capabilityGate({
      kind,
      state: caps[kind],
      sessionReady,
      capsFromServer,
      fallbackTitle,
    });

  // Горячие клавиши: Ctrl/Cmd+K — поиск по списку чатов,
  // Ctrl/Cmd+Shift+O — новый чат. e.code не зависит от раскладки.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.code === "KeyK" && !e.shiftKey) {
        e.preventDefault();
        const st = useStore.getState();
        st.setSidebarOpen(true);
        if (st.sidebarCollapsed) st.setSidebarCollapsed(false);
        setTimeout(() => {
          document.getElementById("chat-filter-input")?.focus();
        }, 50);
      } else if (e.code === "KeyO" && e.shiftKey) {
        e.preventDefault();
        useStore
          .getState()
          .newSession()
          .catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const handleExportChat = () => {
    const st = useStore.getState();
    const sid = st.currentID;
    if (!sid) return;
    const msgs = st.messages[sid] ?? [];
    if (msgs.length === 0) {
      toast("info", "В этом чате пока нет сообщений");
      return;
    }
    const title =
      st.sessionTitleOverrides[sid] ||
      st.sessions.find((x) => x.id === sid)?.title ||
      "Чат Z Agent";
    downloadTextFile(
      `z-agent-chat-${sid.slice(0, 8)}.md`,
      buildChatMarkdown(msgs, title),
    );
    toast("success", "Чат сохранён в Markdown-файл");
  };



  return (
    <>
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:px-4">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
          onClick={() => setSidebarOpen(true)}
          data-testid="mobile-menu-btn"
          title="Меню"
          aria-label="Открыть меню"
        >
          <MenuIcon />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="hidden md:flex h-8 w-8 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={toggleSidebar}
          title={
            sidebarCollapsed
              ? "Показать боковую панель"
              : "Скрыть боковую панель"
          }
          aria-label={
            sidebarCollapsed
              ? "Показать боковую панель"
              : "Скрыть боковую панель"
          }
        >
          {sidebarCollapsed ? (
            <SidebarLeftExpandIcon size={16} />
          ) : (
            <SidebarLeftCollapseIcon size={16} />
          )}
        </Button>

        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="mx-auto shrink-0">
            <ModelSelector />
          </div>
        </div>

        <Button
          variant="ghost"
          size="icon"
          className="hidden h-8 w-8 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 md:inline-flex"
          onClick={handleExportChat}
          disabled={!sessionReady}
          title="Скачать чат в Markdown"
          aria-label="Скачать чат в Markdown"
        >
          <DownloadIcon size={16} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="hidden h-8 w-8 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40 md:inline-flex"
          onClick={() => {
            window.dispatchEvent(new Event("z-agent:chat-search"));
          }}
          disabled={!sessionReady}
          title="Поиск по чату (Ctrl+F)"
          aria-label="Поиск по сообщениям чата"
        >
          <SearchIcon size={16} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          onClick={() => setShowTerminal(true)}
          {...gate("terminal", "Терминал")}
          aria-label="Открыть терминал"
        >
          <BashIcon size={16} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          onClick={() => setShowPreview(true)}
          {...gate("preview", "Предпросмотр")}
          aria-label="Открыть предпросмотр"
        >
          <PreviewIcon size={16} />
        </Button>

        {/* aria-pressed — это кнопка-переключатель, и её состояние должно быть
            видно скринридеру, а не только по цвету варианта. Заодно даёт e2e
            надёжный признак: workspaceOpen приезжает с сервера асинхронно
            (prefsSync), поэтому «нажать, чтобы открыть» без проверки состояния
            иногда закрывало панель. */}
        <Button
          variant={workspaceOpen ? "secondary" : "ghost"}
          size="icon"
          className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => setWorkspaceOpen(!workspaceOpen)}
          title="Файлы проекта"
          aria-label="Показать или скрыть файлы проекта"
          aria-pressed={workspaceOpen}
          data-testid="workspace-toggle"
        >
          {workspaceOpen ? (
            <WorkspaceOpenIcon size={16} />
          ) : (
            <WorkspaceClosedIcon size={16} />
          )}
        </Button>
      </header>

      <PanelModal
        title="Терминал"
        open={showTerminal}
        onClose={() => setShowTerminal(false)}
      >
        <div className="h-full w-full p-2">
          <LazyPanel label="терминал" skeleton={<PanelBodySkeleton />}>
            <Terminal workdir={currentID || ""} />
          </LazyPanel>
        </div>
      </PanelModal>

      <PanelModal
        title="Предпросмотр"
        open={showPreview}
        onClose={() => setShowPreview(false)}
      >
        <LazyPanel label="предпросмотр" skeleton={<PanelBodySkeleton />}>
          <PreviewPanel
            url={currentID ? `/api/sandbox-proxy/${currentID}/` : ""}
          />
        </LazyPanel>
      </PanelModal>
    </>
  );
}
