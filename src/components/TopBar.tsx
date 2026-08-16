import { GitBranch } from "lucide-react";
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

/** Heavy/secondary panels are loaded only when the user asks for them. */
const Terminal = lazy(() =>
  import("./Terminal").then((m) => ({ default: m.Terminal })),
);
const PreviewPanel = lazy(() =>
  import("./PreviewPanel").then((m) => ({ default: m.PreviewPanel })),
);
const ChangesPanel = lazy(() => import("./ChangesPanel"));

export default function TopBar() {
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const workspaceOpen = useStore((s) => s.workspaceOpen);
  const setWorkspaceOpen = useStore((s) => s.setWorkspaceOpen);
  const currentID = useStore((s) => s.currentID);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const sessionReady = !!currentID && !isTmpSession(currentID);

  /** Runtime capability state for terminal/preview/workspace. */
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
        // Keep the last known state during a short network interruption.
      }
    };
    read();
    const timer = setInterval(read, CAPABILITY_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [capsFromServer, sessionReady, currentID]);

  const gate = (kind: CapabilityKind, fallbackTitle: string) =>
    capabilityGate({
      kind,
      state: caps[kind],
      sessionReady,
      capsFromServer,
      fallbackTitle,
    });

  // Горячие клавиши: Ctrl/Cmd+K — поиск по списку чатов,
  // Ctrl/Cmd+Shift+O — новый чат.
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
      <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-1.5 border-b border-border bg-background/95 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/85 md:gap-2 md:px-4">
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
          className="hidden h-8 w-8 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground md:flex"
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

        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="mx-auto min-w-0 max-w-full">
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
          className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          onClick={() => setShowTerminal(true)}
          {...gate("terminal", "Терминал")}
          aria-label="Открыть терминал"
        >
          <BashIcon size={16} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          onClick={() => setShowPreview(true)}
          {...gate("preview", "Предпросмотр")}
          aria-label="Открыть предпросмотр"
        >
          <PreviewIcon size={16} />
        </Button>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
          onClick={() => setShowChanges(true)}
          disabled={!sessionReady}
          title="Результат и изменения проекта"
          aria-label="Показать результат и изменения проекта"
        >
          <GitBranch className="h-4 w-4" />
        </Button>

        <Button
          variant={workspaceOpen ? "secondary" : "ghost"}
          size="icon"
          className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
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

      <PanelModal
        title="Результат"
        open={showChanges}
        onClose={() => setShowChanges(false)}
      >
        <LazyPanel label="результат" skeleton={<PanelBodySkeleton />}>
          <ChangesPanel />
        </LazyPanel>
      </PanelModal>
    </>
  );
}
