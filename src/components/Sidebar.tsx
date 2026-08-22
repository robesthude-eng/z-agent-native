import { useCallback, useMemo, useRef, useState } from "react";
import { useConfirm } from "@/components/ConfirmDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { api } from "../api/client";
import type { SessionInfo } from "../api/types";
import { messageText } from "../lib/chatText";
import { useStore } from "../store/useStore";
import {
  CloseIcon,
  FolderIcon,
  LogoutIcon,
  MoonIcon,
  NewChatIcon,
  PencilIcon,
  PinIcon,
  SettingsIcon,
  SunIcon,
  TrashIcon,
  UserIcon,
} from "./icons";
import { buildSidebarGroups } from "./sidebar/chatGrouping";
import { t, tf } from "@/i18n";

type DeepHit = { id: string; title: string; snippet: string };

function SidebarUserEmail({ email }: { email: string }) {
  const handleClick = () => {
    copyText(email).then((ok) => {
      if (ok) toast("success", tf("sidebar.email_skopirovan_0", [email]));
      else toast("error", t("sidebar.ne_udalos_skopirovat_email"));
    });
  };

  return (
    <div className="relative flex-1 min-w-0">
      <button
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted transition text-left"
        onClick={handleClick}
        title={tf("sidebar.skopirovat_email_0", [email])}
        type="button"
      >
        <UserIcon size={14} />
        <span className="truncate flex-1 text-muted-foreground">{email}</span>
      </button>
    </div>
  );
}

export default function Sidebar() {
  const askConfirm = useConfirm();
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
  // Какому чату открыт выбор папки, какие папки свёрнуты, поле новой папки.
  const [folderMenuFor, setFolderMenuFor] = useState<string | null>(null);
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(
    new Set(),
  );
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const [confirmDeleteFolderId, setConfirmDeleteFolderId] = useState<
    string | null
  >(null);

  const normalizedFilter = filter.trim().toLowerCase();

  const titleOf = useCallback(
    (s: SessionInfo) => sessionTitleOverrides[s.id] || s.title || t("shortcuts_overlay.novyy_chat"),
    [sessionTitleOverrides],
  );

  // Раскладка «закреплённые → папки → даты» — чистая функция с тестами,
  // см. sidebar/chatGrouping.ts.
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

  // Глобальный поиск: грузим сообщения последних сессий и ищем по тексту.
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
          const t = messageText(m);
          const i = t.toLowerCase().indexOf(q);
          if (i >= 0) {
            hits.push({
              id: sess.id,
              title:
                sessionTitleOverrides[sess.id] || sess.title || t("shortcuts_overlay.novyy_chat"),
              snippet: t.slice(Math.max(0, i - 40), i + 60).trim(),
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

  // Новый запрос в фильтре сбрасывает результаты глубокого поиска.
  // Сброс на рендере, а не в useEffect: тело эффекта не читало
  // normalizedFilter, поэтому зависимость выглядела лишней, а выдача по
  // прошлому запросу успевала мелькнуть один кадр после ввода.
  const deepQueryRef = useRef(normalizedFilter);
  if (deepQueryRef.current !== normalizedFilter) {
    deepQueryRef.current = normalizedFilter;
    setDeepResults(null);
  }

  return (
    <>
      {/* Mobile backdrop — кнопка, а не div: тап мимо панели закрывает её
          и с клавиатуры тоже, а data-testid для мобильных e2e сохраняется. */}
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
          // 260px вместо 224: в узкой панели названия чатов и папок обрезались
          // почти сразу, а с папками в списке появился ещё один уровень отступа.
          "fixed md:static inset-y-0 left-0 z-50 w-[min(260px,85vw)] shrink-0",
          // Тон вместо линии: панель отделена от ленты собственным фоном, а не
          // границей. Так устроены оба референса, и так спокойнее — на экране
          // одной чертой меньше.
          "bg-card",
          "flex flex-col h-dvh md:h-full transition-transform duration-[320ms] text-foreground",
          sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0",
        )}
      >
        {/* Top */}
        <div className="flex flex-col gap-2 px-3 pb-3 pt-3">
          <div className="flex items-center gap-2 w-full">
            <Button
              data-testid="new-chat-btn"
              className="h-9 flex-1 justify-start gap-2 rounded-xl border border-border bg-transparent text-[12px] font-medium text-foreground shadow-none hover:bg-accent"
              onClick={() => {
                newSession();
                close();
              }}
            >
              <NewChatIcon />
              <span>{t("shortcuts_overlay.novyy_chat")}</span>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={close}
              title={t("panel_modal.zakryt")}
              aria-label={t("sidebar.zakryt_menyu")}
              className="md:hidden"
            >
              <CloseIcon />
            </Button>
          </div>
        </div>

        {/* Chat list */}
        <div className="px-2 pt-2">
          <input
            id="chat-filter-input"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("sidebar.poisk_chatov_ctrl_k")}
            aria-label={t("shortcuts_overlay.poisk_po_spisku_chatov")}
            className="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
          />
          {normalizedFilter && (
            <button
              type="button"
              className="mt-1 w-full rounded-lg border border-dashed border-border px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={runDeepSearch}
              disabled={deepBusy}
            >
              {deepBusy
                ? t("sidebar.ischu_v_soobscheniyah")
                : t("sidebar.ud83d_udd0e_iskat_v_soobscheniyah_chatov")}
            </button>
          )}
          {deepResults && (
            <div className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-border">
              {deepResults.length === 0 && (
                <p className="px-2 py-2 text-[11px] text-muted-foreground">
                  Совпадений в сообщениях нет
                </p>
              )}
              {deepResults.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className="block w-full px-2 py-1.5 text-left hover:bg-accent"
                  onClick={() => {
                    select(r.id);
                    close();
                    setDeepResults(null);
                  }}
                >
                  <span className="block truncate text-[11px] text-foreground">
                    {r.title}
                  </span>
                  <span className="block truncate text-[10px] text-muted-foreground">
                    …{r.snippet}…
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <ScrollArea className="flex-1 w-full" style={{ width: "100%" }}>
          <nav
            className="space-y-1 p-2"
            style={{ width: "100%", overflowX: "hidden" }}
          >
            {totalVisible === 0 && chatFolders.length === 0 && (
              <p className="px-3 py-8 text-sm text-muted-foreground text-center">
                {normalizedFilter ? t("settings_panel.nichego_ne_naydeno") : t("sidebar.poka_net_dialogov")}
              </p>
            )}

            {/* Создание папки. Само поле показываем по клику, чтобы в обычном
                состоянии сайдбар не занимала лишняя строка ввода. */}
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
                  <div className="group/folder flex items-center gap-1 px-1 pb-1 pt-2">
                    {editingFolderId === g.folderId ? (
                      <input
                        ref={(el) => el?.focus()}
                        value={folderNameDraft}
                        onChange={(e) => setFolderNameDraft(e.target.value)}
                        onBlur={() => {
                          if (g.folderId)
                            renameChatFolder(g.folderId, folderNameDraft);
                          setEditingFolderId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            if (g.folderId)
                              renameChatFolder(g.folderId, folderNameDraft);
                            setEditingFolderId(null);
                          }
                          if (e.key === "Escape") setEditingFolderId(null);
                        }}
                        aria-label={t("sidebar.novoe_nazvanie_papki")}
                        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-0.5 text-[11px] text-foreground outline-none"
                      />
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={() =>
                            setCollapsedFolders((prev) => {
                              const next = new Set(prev);
                              if (g.folderId) {
                                if (next.has(g.folderId))
                                  next.delete(g.folderId);
                                else next.add(g.folderId);
                              }
                              return next;
                            })
                          }
                          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-0.5 text-left font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 transition hover:text-foreground"
                          title={tf("sidebar.0_papku_1", [collapsedFolders.has(g.folderId) ? t("sidebar.razvernut") : t("sidebar.svernut"), g.label])}
                        >
                          <span aria-hidden="true">
                            {collapsedFolders.has(g.folderId) ? "▸" : "▾"}
                          </span>
                          <span className="truncate">{g.label}</span>
                          <span className="shrink-0 opacity-60">
                            {g.items.length}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setFolderNameDraft(g.label);
                            setEditingFolderId(g.folderId ?? null);
                          }}
                          title={t("sidebar.pereimenovat_papku")}
                          aria-label={tf("sidebar.pereimenovat_papku_0", [g.label])}
                          className="shrink-0 rounded p-0.5 text-[11px] opacity-0 transition group-hover/folder:opacity-60 hover:opacity-100"
                        >
                          <PencilIcon size={13} />
                        </button>
                        {confirmDeleteFolderId === g.folderId ? (
                          // Тот же инлайн-паттерн, что у удаления чата: нативный
                          // confirm() выбивался из интерфейса и блокировал вкладку.
                          <span className="mr-1 flex shrink-0 items-center gap-1 rounded-lg border border-red-500/20 bg-red-500/10 py-0.5">
                            <span className="pl-1.5 pr-0.5 text-[10px] font-semibold text-red-500/90">
                              Удалить?
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                if (g.folderId) deleteChatFolder(g.folderId);
                                setConfirmDeleteFolderId(null);
                              }}
                              title={t("sidebar.podtverdit_udalenie_papki_chaty_ostanutsya")}
                              aria-label={tf("sidebar.podtverdit_udalenie_papki_0", [g.label])}
                              className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-red-500 text-white transition hover:bg-red-600"
                            >
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <polyline points="20 6 9 17 4 12" />
                              </svg>
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteFolderId(null)}
                              title={t("confirm_dialog.otmena")}
                              aria-label={t("sidebar.otmenit_udalenie_papki")}
                              className="mr-1 inline-flex h-5 w-5 items-center justify-center rounded-md bg-muted text-muted-foreground transition hover:bg-muted-foreground/20"
                            >
                              <svg
                                width="10"
                                height="10"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.5"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <line x1="18" y1="6" x2="6" y2="18" />
                                <line x1="6" y1="6" x2="18" y2="18" />
                              </svg>
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              setConfirmDeleteFolderId(g.folderId ?? null)
                            }
                            title={t("sidebar.udalit_papku")}
                            aria-label={tf("sidebar.udalit_papku_0", [g.label])}
                            className="mr-1 shrink-0 rounded p-0.5 text-[11px] opacity-0 transition group-hover/folder:opacity-60 hover:opacity-100"
                          >
                            <TrashIcon size={13} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  <div className="px-3 pb-1 pt-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                    {g.label}
                  </div>
                )}
                {g.kind === "folder" &&
                  g.folderId &&
                  g.items.length === 0 &&
                  !collapsedFolders.has(g.folderId) && (
                    <p className="px-4 pb-1 text-[10.5px] text-muted-foreground/60">
                      Пусто — перенесите сюда чат кнопкой «папка»
                    </p>
                  )}
                {(g.kind !== "folder" ||
                  !g.folderId ||
                  !collapsedFolders.has(g.folderId)) &&
                  g.items.map((s) => {
                    const isActive = s.id === currentID;
                    const displayTitle =
                      sessionTitleOverrides[s.id] || s.title || t("shortcuts_overlay.novyy_chat");
                    const isPinned = pinnedSessions.includes(s.id);
                    const sStatus =
                      typeof status[s.id] === "string"
                        ? status[s.id]
                        : (status[s.id] as { type?: string })?.type;
                    const busy = sStatus === "busy";
                    return (
                      <div key={s.id}>
                        <div
                          className={cn(
                            "group rounded-lg text-[12px] transition",
                            isActive
                              ? "oc-reveal-open bg-accent text-foreground"
                              : "text-muted-foreground hover:bg-accent hover:text-foreground",
                          )}
                          style={{
                            width: "100%",
                            maxWidth: "100%",
                            boxSizing: "border-box",
                            display: "flex",
                            alignItems: "stretch",
                            // Кнопки действий стоят вплотную: четыре 32px иконки с
                            // зазорами съедали ~148px из 260px сайдбара и название
                            // чата обрезалось после пары слов.
                            gap: 2,
                            overflow: "hidden",
                          }}
                        >
                          {editingId === s.id ? (
                            <input
                              ref={(el) => el?.focus()}
                              value={editText}
                              onChange={(e) => setEditText(e.target.value)}
                              onBlur={() => commitRename(s.id)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") commitRename(s.id);
                                if (e.key === "Escape") setEditingId(null);
                              }}
                              aria-label={t("sidebar.novoe_nazvanie_chata")}
                              style={{ flex: 1, minWidth: 0 }}
                              className="mx-2 my-1.5 self-center rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none"
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                select(s.id);
                                close();
                              }}
                              style={{
                                flex: 1,
                                minWidth: 0,
                                display: "flex",
                                alignItems: "center",
                                gap: 6,
                                paddingLeft: 10,
                                paddingRight: 2,
                                paddingTop: 8,
                                paddingBottom: 8,
                                background: "transparent",
                                border: "none",
                                color: "inherit",
                                font: "inherit",
                                cursor: "pointer",
                                textAlign: "left",
                                borderRadius: 12,
                              }}
                            >
                              {busy && (
                                <span
                                  style={{
                                    width: 6,
                                    height: 6,
                                    borderRadius: "50%",
                                    background: "var(--color-success)",
                                    flexShrink: 0,
                                  }}
                                />
                              )}
                              <span
                                style={{
                                  flex: 1,
                                  minWidth: 0,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {displayTitle}
                              </span>
                            </button>
                          )}
                          {editingId !== s.id && (
                            <>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  togglePinnedSession(s.id);
                                }}
                                title={
                                  isPinned ? t("sidebar.otkrepit_chat") : t("sidebar.zakrepit_chat")
                                }
                                aria-label={tf("sidebar.0_chat_1", [isPinned ? t("sidebar.otkrepit") : t("sidebar.zakrepit"), displayTitle])}
                                className={cn(
                                  "oc-reveal inline-flex h-6 w-6 shrink-0 self-center items-center justify-center rounded-md border-none bg-transparent p-0 text-[11px] leading-none text-current transition-all hover:bg-accent active:scale-90",
                                  isPinned
                                    ? "opacity-90"
                                    : "opacity-45 hover:opacity-100",
                                )}
                              >
                                <PinIcon size={13} />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setFolderMenuFor((cur) =>
                                    cur === s.id ? null : s.id,
                                  );
                                }}
                                title={t("sidebar.papka_chata")}
                                aria-label={tf("sidebar.vybrat_papku_dlya_chata_0", [displayTitle])}
                                className={cn(
                                  "oc-reveal inline-flex h-6 w-6 shrink-0 self-center items-center justify-center rounded-md border-none bg-transparent p-0 text-[11px] leading-none text-current transition-all hover:bg-accent active:scale-90",
                                  chatFolderAssignments[s.id]
                                    ? "opacity-90"
                                    : "opacity-45 hover:opacity-100",
                                )}
                              >
                                <FolderIcon size={13} />
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingId(s.id);
                                  setEditText(
                                    sessionTitleOverrides[s.id] ||
                                      s.title ||
                                      "",
                                  );
                                }}
                                title={t("sidebar.pereimenovat_chat")}
                                aria-label={tf("sidebar.pereimenovat_chat_0", [displayTitle])}
                                className="oc-reveal inline-flex h-6 w-6 shrink-0 self-center items-center justify-center rounded-md border-none bg-transparent p-0 text-[11px] leading-none text-current opacity-45 transition-all hover:bg-accent hover:opacity-100 active:scale-90"
                              >
                                <PencilIcon size={13} />
                              </button>
                            </>
                          )}
                          {confirmDeleteId === s.id ? (
                            <div className="mr-0.5 flex items-center gap-0.5 self-center rounded-md border border-red-500/20 bg-red-500/10 py-0.5">
                              <span className="pl-1 pr-0.5 text-[10px] font-semibold text-red-500/90">
                                Удалить?
                              </span>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeSession(s.id);
                                  setConfirmDeleteId(null);
                                }}
                                title={t("sidebar.podtverdit_udalenie")}
                                className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-red-500 text-white hover:bg-red-600 transition"
                              >
                                <svg
                                  aria-hidden="true"
                                  width="10"
                                  height="10"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setConfirmDeleteId(null);
                                }}
                                title={t("confirm_dialog.otmena")}
                                className="mr-0.5 inline-flex h-5 w-5 items-center justify-center rounded-md bg-muted hover:bg-muted-foreground/20 text-muted-foreground transition"
                              >
                                <svg
                                  aria-hidden="true"
                                  width="10"
                                  height="10"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2.5"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                >
                                  <line x1="18" y1="6" x2="6" y2="18" />
                                  <line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setConfirmDeleteId(s.id);
                              }}
                              title={t("sidebar.udalit_chat")}
                              aria-label={tf("sidebar.udalit_chat_0", [displayTitle])}
                              className="oc-reveal mr-0.5 inline-flex h-6 w-6 shrink-0 self-center items-center justify-center rounded-md border-none bg-transparent p-0 text-current opacity-45 transition-all hover:bg-red-500/12 hover:text-red-500 hover:opacity-100 active:scale-90"
                            >
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.75"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                                aria-hidden="true"
                              >
                                <path d="M3 6h18" />
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                              </svg>
                            </button>
                          )}
                        </div>
                        {folderMenuFor === s.id && (
                          <div className="mx-1 mb-1 rounded-lg border border-border bg-card p-1">
                            <button
                              type="button"
                              className={cn(
                                "block w-full truncate rounded-md px-2 py-1 text-left text-[11px] transition hover:bg-accent",
                                !chatFolderAssignments[s.id] &&
                                  "text-primary font-medium",
                              )}
                              onClick={() => {
                                assignChatFolder(s.id, null);
                                setFolderMenuFor(null);
                              }}
                            >
                              Без папки
                            </button>
                            {chatFolders.map((f) => (
                              <button
                                key={f.id}
                                type="button"
                                className={cn(
                                  "block w-full truncate rounded-md px-2 py-1 text-left text-[11px] transition hover:bg-accent",
                                  chatFolderAssignments[s.id] === f.id &&
                                    "text-primary font-medium",
                                )}
                                onClick={() => {
                                  assignChatFolder(s.id, f.id);
                                  setFolderMenuFor(null);
                                }}
                              >
                                <FolderIcon size={13} />
                                {f.name}
                              </button>
                            ))}
                            <input
                              value={newFolderName}
                              onChange={(e) => setNewFolderName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") submitNewFolder(s.id);
                                if (e.key === "Escape") {
                                  setNewFolderName("");
                                  setFolderMenuFor(null);
                                }
                              }}
                              placeholder={t("sidebar.novaya_papka_2")}
                              aria-label={t("sidebar.sozdat_papku_i_perenesti_chat_v")}
                              className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground outline-none focus:border-ring"
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            ))}
          </nav>
        </ScrollArea>

        {/* Bottom */}
        <div className="space-y-2 border-t border-border p-3">
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              className="h-8 flex-1 justify-start gap-2 rounded-lg px-2 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setSettingsOpen(true)}
            >
              <SettingsIcon />
              <span>{t("settings_panel.nastroyki")}</span>
              {authedCount > 0 && (
                <Badge
                  variant="secondary"
                  className="ml-auto h-5 px-1.5 text-[11px]"
                >
                  {authedCount}
                </Badge>
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              data-testid="theme-toggle"
              aria-label={t("sidebar.pereklyuchit_temu")}
              onClick={toggleTheme}
              title={tf("sidebar.tema_0_nazhmite_chtoby_pereklyuchit", [
                theme === "dark"
                  ? t("sidebar.temnaya")
                  : theme === "mid"
                    ? t("sidebar.srednyaya")
                    : t("sidebar.svetlaya"),
              ])}
            >
              {theme === "light" ? (
                <MoonIcon />
              ) : theme === "mid" ? (
                <span className="opacity-60 inline-flex">
                  <SunIcon />
                </span>
              ) : (
                <SunIcon />
              )}
            </Button>
          </div>

          {currentUser && (
            <>
              <Separator />
              <div className="flex items-center gap-2">
                <SidebarUserEmail email={currentUser.email} />
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-red-400 hover:text-red-300 hover:bg-red-500/10 shrink-0"
                  onClick={async () => {
                    const ok = await askConfirm({
                      title: t("sidebar.vyyti_iz_akkaunta"),
                      description: tf("sidebar.seans_0_zakroetsya_na_etom_ustroystve", [currentUser.email]),
                      confirmLabel: t("sidebar.vyyti"),
                      destructive: true,
                    });
                    if (ok) logout();
                  }}
                  title={tf("sidebar.vyyti_0", [currentUser.email])}
                >
                  <LogoutIcon />
                </Button>
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
