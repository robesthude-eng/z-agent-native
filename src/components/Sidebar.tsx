import { useCallback, useMemo, useRef, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { api } from "../api/client";
import type { SessionInfo } from "../api/types";
import { messageText } from "../lib/chatText";
import { useStore } from "../store/useStore";
import { buildSidebarGroups } from "./sidebar/chatGrouping";
import { SidebarChatItem } from "./sidebar/SidebarChatItem";
import { SidebarFooter } from "./sidebar/SidebarFooter";
import { type DeepHit, SidebarHeader } from "./sidebar/SidebarHeader";

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
        titleOf,
        filter: normalizedFilter,
      }),
    [sessions, pinnedSessions, titleOf, normalizedFilter],
  );
  const totalVisible = useMemo(
    () => groups.reduce((n, g) => n + g.items.length, 0),
    [groups],
  );

  // Enter → commit и тут же blur → commit; Escape → cancel и blur → commit.
  // Коммитим только пока поле действительно в режиме правки этого чата.
  const editingRef = useRef<string | null>(null);
  editingRef.current = editingId;
  const commitRename = (id: string) => {
    if (editingRef.current !== id) return;
    editingRef.current = null;
    setEditingId(null);
    const next = editText.trim();
    const session = sessions.find((x) => x.id === id);
    const current = session ? titleOf(session) : "";
    if (next && next !== current) renameSession(id, next);
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
          "agent-sidebar fixed md:static inset-y-0 left-0 z-50 w-[min(236px,85vw)] shrink-0 bg-card flex flex-col h-dvh md:h-full transition-transform duration-[320ms] text-foreground",
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
          <nav
            className="space-y-1 p-2"
            style={{ width: "100%", overflowX: "hidden" }}
          >
            {totalVisible === 0 && (
              <p className="px-3 py-8 text-sm text-muted-foreground text-center">
                {normalizedFilter
                  ? t("settings_panel.nichego_ne_naydeno")
                  : t("sidebar.poka_net_dialogov")}
              </p>
            )}

            {groups.map((g) => (
              <div key={g.key}>
                <div className="px-3 pb-2 pt-6 text-sm font-normal text-muted-foreground">
                  {g.label}
                </div>

                {g.items.map((s) => {
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
                      onCancelEditing={() => {
                        editingRef.current = null;
                        setEditingId(null);
                      }}
                      onTogglePin={() => togglePinnedSession(s.id)}
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
