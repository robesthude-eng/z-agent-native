import { useCallback, useMemo, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { api } from "../api/client";
import type { SessionInfo } from "../api/types";
import { messageText } from "../lib/chatText";
import { useStore } from "../store/useStore";
import { FolderIcon } from "./icons";
import { buildSidebarGroups } from "./sidebar/chatGrouping";
import { SidebarHeader, type DeepHit } from "./sidebar/SidebarHeader";
import { SidebarFolderItem } from "./sidebar/SidebarFolderItem";
import { SidebarChatItem } from "./sidebar/SidebarChatItem";
import { SidebarFooter } from "./sidebar/SidebarFooter";
import { t } from "@/i18n";

export default function Sidebar() {
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [deepBusy, setDeepBusy] = useState(false);
  const [deepResults, setDeepResults] = useState<DeepHit[] | null>(null);
  const sessions = useStore((s) => s.sessions);
  const currentID = useStore((s) => s.currentID);
  const select = useStore((s) => s.select);
  const newSession = useStore((s) => s.newSession);
  const removeSession = useStore((s) => s.removeSession);
  const pinnedSessions = useStore((s) => s.pinnedSessions);
  const togglePinnedSession = useStore((s) => s.togglePinnedSession);
  const sessionTitleOverrides = useStore((s) => s.sessionTitleOverrides);
  const renameSession = useStore((s) => s.renameSession);

  const chatFolders = useStore((s) => s.chatFolders);
  const chatFolderAssignments = useStore((s) => s.chatFolderAssignments);
  const createChatFolder = useStore((s) => s.createChatFolder);
  const renameChatFolder = useStore((s) => s.renameChatFolder);
  const deleteChatFolder = useStore((s) => s.deleteChatFolder);
  const assignChatFolder = useStore((s) => s.assignChatFolder);
  const [folderMenuFor, setFolderMenuFor] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(new Set());
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const [confirmDeleteFolderId, setConfirmDeleteFolderId] = useState<string | null>(null);

  const normalizedFilter = filter.trim().toLowerCase();

  const titleOf = useCallback(
    (s: SessionInfo) =>
      sessionTitleOverrides[s.id] ||
      s.title ||
      t("shortcuts_overlay.novyy_chat"),
    [sessionTitleOverrides],
  );

  const groups = useMemo(
    () =>
      buildSidebarGroups({
        sessions,
        pinnedSessions,
        folders: chatFolders,
        assignments: chatFolderAssignments,
        titleOf,
        filter: normalizedFilter,
      }),
    [
      sessions,
      pinnedSessions,
      chatFolders,
      chatFolderAssignments,
      titleOf,
      normalizedFilter,
    ],
  );
  const totalVisible = useMemo(
    () => groups.reduce((n, g) => n + g.items.length, 0),
    [groups],
  );

  const commitRename = (id: string) => {
    renameSession(id, editText.trim());
    setEditingId(null);
  };

  const submitNewFolder = (assignSessionId?: string) => {
    const id = createChatFolder(newFolderName);
    setNewFolderName("");
    setNewFolderOpen(false);
    if (!id) return;
    if (assignSessionId) assignChatFolder(assignSessionId, id);
    setFolderMenuFor(null);
  };

  const runDeepSearch = async () => {
    const q = normalizedFilter;
    if (!q || deepBusy) return;
    setDeepBusy(true);
    try {
      const st = useStore.getState();
      const hits: DeepHit[] = [];
      for (const sess of sessions.slice(0, 30)) {
        const msgs =
          st.messages[sess.id] ??
          (await api.listMessages(sess.id).catch(() => []));
        for (const m of msgs) {
          const text = messageText(m);
          const i = text.toLowerCase().indexOf(q);
          if (i >= 0) {
            hits.push({
              id: sess.id,
              title:
                sessionTitleOverrides[sess.id] ||
                sess.title ||
                t("shortcuts_overlay.novyy_chat"),
              snippet: text.slice(Math.max(0, i - 40), i + 60).trim(),
            });
            break;
          }
        }
      }
      setDeepResults(hits);
    } finally {
      setDeepBusy(false);
    }
  };

  const status = useStore((s) => s.status);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const currentUser = useStore((s) => s.currentUser);
  const logout = useStore((s) => s.logout);
  const authedCount = Object.keys(useStore((s) => s.authed)).length;

  const close = () => setSidebarOpen(false);

  const deepQueryRef = useRef(normalizedFilter);
  if (deepQueryRef.current !== normalizedFilter) {
    deepQueryRef.current = normalizedFilter;
    setDeepResults(null);
  }

  return (
    <>
      {sidebarOpen && (
        <button
          type="button"
          data-testid="sidebar-backdrop"
          aria-label={t("sidebar.zakryt_bokovoe_menyu")}
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm md:hidden"
          onClick={close}
        />
      )}
      <aside
        data-testid="sidebar"
        data-open={sidebarOpen ? "true" : "false"}
        className={cn(
          "fixed md:static inset-y-0 left-0 z-50 w-[min(260px,85vw)] shrink-0 bg-card flex flex-col h-dvh md:h-full transition-transform duration-[320ms] text-foreground",
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
      >
        <SidebarHeader
          filter={filter}
          setFilter={setFilter}
          normalizedFilter={normalizedFilter}
          deepBusy={deepBusy}
          deepResults={deepResults}
          runDeepSearch={runDeepSearch}
          onSelectSession={select}
          onNewSession={newSession}
          onClose={close}
        />

        <ScrollArea className="flex-1 w-full" style={{ width: "100%" }}>
          <nav className="space-y-1 p-2" style={{ width: "100%", overflowX: "hidden" }}>
            {totalVisible === 0 && chatFolders.length === 0 && (
              <p className="px-3 py-8 text-sm text-muted-foreground text-center">
                {normalizedFilter
                  ? t("settings_panel.nichego_ne_naydeno")
                  : t("sidebar.poka_net_dialogov")}
              </p>
            )}

            {!normalizedFilter && (
              <div className="px-1 pb-1">
                {newFolderOpen ? (
                  <input
                    ref={(el) => el?.focus()}
                    value={newFolderName}
                    onChange={(e) => setNewFolderName(e.target.value)}
                    onBlur={() => {
                      if (newFolderName.trim()) submitNewFolder();
                      else setNewFolderOpen(false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") submitNewFolder();
                      if (e.key === "Escape") {
                        setNewFolderName("");
                        setNewFolderOpen(false);
                      }
                    }}
                    placeholder={t("sidebar.nazvanie_papki")}
                    aria-label={t("sidebar.nazvanie_novoy_papki")}
                    className="w-full rounded-lg border border-border bg-background px-2 py-1 text-[11px] text-foreground outline-none focus:border-ring"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => setNewFolderOpen(true)}
                    className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground"
                  >
                    <FolderIcon size={13} />
                    <span>{t("sidebar.novaya_papka")}</span>
                  </button>
                )}
              </div>
            )}

            {groups.map((g) => (
              <div key={g.key}>
                {g.kind === "folder" && g.folderId ? (
                  <SidebarFolderItem
                    folderId={g.folderId}
                    label={g.label}
                    count={g.items.length}
                    isCollapsed={collapsedFolders.has(g.folderId)}
                    isEditing={editingFolderId === g.folderId}
                    editingDraft={folderNameDraft}
                    isConfirmDeleting={confirmDeleteFolderId === g.folderId}
                    onToggleCollapse={() =>
                      setCollapsedFolders((prev) => {
                        const next = new Set(prev);
                        if (g.folderId) {
                          if (next.has(g.folderId)) next.delete(g.folderId);
                          else next.add(g.folderId);
                        }
                        return next;
                      })
                    }
                    onStartEditing={() => {
                      setFolderNameDraft(g.label);
                      setEditingFolderId(g.folderId ?? null);
                    }}
                    onDraftChange={setFolderNameDraft}
                    onCommitRename={() => {
                      if (g.folderId) renameChatFolder(g.folderId, folderNameDraft);
                      setEditingFolderId(null);
                    }}
                    onCancelEditing={() => setEditingFolderId(null)}
                    onStartDelete={() => setConfirmDeleteFolderId(g.folderId ?? null)}
                    onConfirmDelete={() => {
                      if (g.folderId) deleteChatFolder(g.folderId);
                      setConfirmDeleteFolderId(null);
                    }}
                    onCancelDelete={() => setConfirmDeleteFolderId(null)}
                  />
                ) : (
                  <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                    {g.label}
                  </div>
                )}

                {g.kind === "folder" &&
                  g.folderId &&
                  g.items.length === 0 &&
                  !collapsedFolders.has(g.folderId) && (
                    <p className="px-4 pb-1 text-[11px] text-muted-foreground">
                      {t("sidebar.pusto_perenesite_syuda_chat")}
                    </p>
                  )}

                {(g.kind !== "folder" || !g.folderId || !collapsedFolders.has(g.folderId)) &&
                  g.items.map((s) => {
                    const isActive = s.id === currentID;
                    const displayTitle =
                      sessionTitleOverrides[s.id] ||
                      s.title ||
                      t("shortcuts_overlay.novyy_chat");
                    const isPinned = pinnedSessions.includes(s.id);
                    const sStatus =
                      typeof status[s.id] === "string"
                        ? status[s.id]
                        : (status[s.id] as { type?: string })?.type;
                    const busy = sStatus === "busy";
                    return (
                      <SidebarChatItem
                        key={s.id}
                        session={s}
                        isActive={isActive}
                        displayTitle={displayTitle}
                        isPinned={isPinned}
                        busy={busy}
                        isEditing={editingId === s.id}
                        editText={editText}
                        isConfirmDeleting={confirmDeleteId === s.id}
                        folderMenuOpen={folderMenuFor === s.id}
                        chatFolders={chatFolders}
                        currentFolderId={chatFolderAssignments[s.id]}
                        newFolderName={newFolderName}
                        onSelect={() => {
                          select(s.id);
                          close();
                        }}
                        onStartEditing={() => {
                          setEditText(displayTitle);
                          setEditingId(s.id);
                        }}
                        onEditTextChange={setEditText}
                        onCommitRename={() => commitRename(s.id)}
                        onCancelEditing={() => setEditingId(null)}
                        onTogglePin={() => togglePinnedSession(s.id)}
                        onToggleFolderMenu={() =>
                          setFolderMenuFor((prev) => (prev === s.id ? null : s.id))
                        }
                        onAssignFolder={(folderId) => {
                          assignChatFolder(s.id, folderId);
                          setFolderMenuFor(null);
                        }}
                        onNewFolderNameChange={setNewFolderName}
                        onCreateFolderAndAssign={() => submitNewFolder(s.id)}
                        onStartDelete={() => setConfirmDeleteId(s.id)}
                        onConfirmDelete={() => {
                          removeSession(s.id);
                          setConfirmDeleteId(null);
                        }}
                        onCancelDelete={() => setConfirmDeleteId(null)}
                      />
                    );
                  })}
              </div>
            ))}
          </nav>
        </ScrollArea>

        <SidebarFooter
          theme={theme}
          onToggleTheme={toggleTheme}
          onOpenSettings={() => {
            setSettingsOpen(true);
            close();
          }}
          currentUser={currentUser}
          authedCount={authedCount}
          onLogout={logout}
        />
      </aside>
    </>
  );
}
