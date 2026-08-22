import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { lazy, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EventStream } from "./api/events";
import { isInterruptionBarEnabled } from "./api/interruptions";
import ChatView from "./components/ChatView";
import Composer from "./components/Composer";
import { ConfirmProvider } from "./components/ConfirmDialog";
import InterruptionBar from "./components/InterruptionBar";
import { LazyPanel, SettingsPanelSkeleton } from "./components/LazyPanel";
import LoginPage from "./components/LoginPage";
import PermissionDialog from "./components/PermissionDialog";
import ShortcutsOverlay from "./components/ShortcutsOverlay";
import Sidebar from "./components/Sidebar";
import ToastHost from "./components/ToastHost";
import TopBar from "./components/TopBar";
import { TouchHints } from "./components/TouchHints";
import WelcomeTour from "./components/WelcomeTour";
import Workspace from "./components/Workspace";
import { applyTheme } from "./config/theme";
import { isTmpSession } from "./lib/ids";
import { useStore } from "./store/useStore";
import { t } from "@/i18n";

/**
 * Настройки — весь ./components/settings/* (аккаунт, провайдеры и модели)
 * ради модалки, которая открывается по кнопке в сайдбаре. Отдельным чанком
 * она не участвует в первой отрисовке чата.
 */
const SettingsPanel = lazy(() => import("./components/SettingsPanel"));

/**
 * SettingsPanel сам возвращает null, когда закрыт, и держит выбранную вкладку
 * в своём состоянии — поэтому после первого открытия он остаётся
 * смонтированным, как и до разделения бандла. Размонтирование по закрытию
 * сбрасывало бы вкладку на «Модели» при каждом повторном заходе.
 */
function SettingsPanelHost() {
  const settingsOpen = useStore((s) => s.settingsOpen);
  const [everOpened, setEverOpened] = useState(false);

  useEffect(() => {
    if (settingsOpen) setEverOpened(true);
  }, [settingsOpen]);

  if (!everOpened) return null;
  return (
    <LazyPanel label={t("router.nastroyki")} skeleton={<SettingsPanelSkeleton />}>
      <SettingsPanel />
    </LazyPanel>
  );
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const currentUser = useStore((s) => s.currentUser);
  const authChecking = useStore((s) => s.authChecking);
  const checkCurrentUser = useStore((s) => s.checkCurrentUser);

  useEffect(() => {
    checkCurrentUser();
  }, [checkCurrentUser]);

  if (authChecking) {
    return (
      <div className="flex h-dvh w-dvw items-center justify-center bg-background">
        <div className="text-sm text-muted-foreground">
          Загрузка Z Agent…
        </div>
      </div>
    );
  }
  if (!currentUser) return <LoginPage />;
  return <>{children}</>;
}

function AppShell() {
  const loadSessions = useStore((s) => s.loadSessions);
  const applyEvent = useStore((s) => s.applyEvent);
  const setConnection = useStore((s) => s.setConnection);
  const theme = useStore((s) => s.theme);
  const workspaceOpen = useStore((s) => s.workspaceOpen);
  const setWorkspaceOpen = useStore((s) => s.setWorkspaceOpen);
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const loadModels = useStore((s) => s.loadModels);
  const checkConnection = useStore((s) => s.checkConnection);
  const serverConnected = useStore((s) => s.serverConnected);
  const currentUser = useStore((s) => s.currentUser);
  const select = useStore((s) => s.select);
  const currentID = useStore((s) => s.currentID);
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { sessionId?: string };
  // Single SSE stream instance — kept in a ref so the session-switch effect
  // below can retarget it without tearing down the whole subscription.
  const streamRef = useRef<EventStream | null>(null);
  // Баннер «потеряно соединение с потоком событий» показывается с задержкой:
  // мобильная сеть рвёт SSE на ~1-2с при каждом обрыве, и мгновенный баннер
  // мигал бы постоянно. Показываем только если поток реально лежит >8с
  // (статус closed, не idle без выбранного чата).
  const [sseDown, setSseDown] = useState(false);
  const sseDownTimer = useRef<number | null>(null);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);



  useEffect(() => {
    if (!currentUser) return;
    checkConnection();
    loadSessions();
    loadModels();
    // Серверные настройки пользователя (пины, модель) —
    // синхронизация между браузерами и устройствами.
    useStore.getState().syncUserPrefsFromServer();
    // Subscribe the SSE stream to the ACTIVE session's directory-scoped event
    // bus (see eventUrl). Without this, per-session token events never reach
    // the client and streaming degrades to 3s polling batches.
    const initialSid = useStore.getState().currentID;
    const stream = new EventStream(
      undefined,
      initialSid && !isTmpSession(initialSid) ? initialSid : null,
    );
    streamRef.current = stream;
    const off = stream.on((e) => applyEvent(e));
    // Debounce баннера: «closed» — реальный обрыв транспорта. «idle» значит
    // чат ещё не выбран (welcome), это не потеря потока.
    const syncSseUi = () => {
      setConnection(stream.status);
      if (stream.status === "closed") {
        if (sseDownTimer.current === null) {
          sseDownTimer.current = window.setTimeout(
            () => setSseDown(true),
            8000,
          );
        }
        return;
      }
      if (sseDownTimer.current !== null) {
        window.clearTimeout(sseDownTimer.current);
        sseDownTimer.current = null;
      }
      setSseDown(false);
    };
    let poll: ReturnType<typeof setInterval> | null = setInterval(
      syncSseUi,
      400,
    );
    let healthPoll: ReturnType<typeof setInterval> | null = setInterval(
      () => checkConnection(),
      15000,
    );
    let modelsPoll: ReturnType<typeof setInterval> | null = setInterval(
      () => loadModels(true),
      60000,
    );

    // Pause polling when tab is hidden (mobile background, browser tab switch).
    // Saves battery and prevents unnecessary network requests.
    const onVisibility = () => {
      if (document.hidden) {
        if (poll) {
          clearInterval(poll);
          poll = null;
        }
        if (healthPoll) {
          clearInterval(healthPoll);
          healthPoll = null;
        }
        if (modelsPoll) {
          clearInterval(modelsPoll);
          modelsPoll = null;
        }
      } else {
        if (!poll) poll = setInterval(syncSseUi, 400);
        if (!healthPoll)
          healthPoll = setInterval(() => checkConnection(), 15000);
        if (!modelsPoll)
          modelsPoll = setInterval(() => loadModels(true), 60000);
        checkConnection(); // immediate check on resume
        // P1-fix: после возврата на вкладку SSE мог умереть (телефон спал,
        // ноутбук закрыт) — сбрасываем backoff и переподключаемся сразу.
        stream.wake();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    // P1-fix: сеть вернулась (Wi-Fi/VPN) — немедленный reconnect вместо
    // ожидания хвоста экспоненциального backoff (до 30s) или "give up".
    const onOnline = () => stream.wake();
    window.addEventListener("online", onOnline);

    return () => {
      off();
      stream.close();
      if (streamRef.current === stream) streamRef.current = null;
      if (poll) clearInterval(poll);
      if (sseDownTimer.current !== null) {
        window.clearTimeout(sseDownTimer.current);
        sseDownTimer.current = null;
      }
      if (healthPoll) clearInterval(healthPoll);
      if (modelsPoll) clearInterval(modelsPoll);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, [
    currentUser,
    loadSessions,
    loadModels,
    applyEvent,
    setConnection,
    checkConnection,
  ]);

  // Real-time streaming: retarget the SSE stream at the active session so its
  // directory-scoped token events (message.part.updated / .delta) arrive live.
  useEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const sid = currentID && !isTmpSession(currentID) ? currentID : null;
    stream.switchSession(sid);
  }, [currentID]);

  // Sync URL → store (ignore optimistic temp IDs).
  //
  // This must react to a URL change, not to every currentID change. Otherwise
  // clicking NEW does `select(NEW)`, then this effect still sees the OLD URL in
  // the same render and immediately selects OLD back before store→URL navigation
  // has committed. That made a visible chat in the sidebar impossible to open.
  useEffect(() => {
    const sid = params.sessionId;
    if (!sid || isTmpSession(sid) || sid === useStore.getState().currentID) {
      return;
    }
    select(sid).catch(() => {});
  }, [params.sessionId, select]);

  // Sync store → URL when chat selected without route param (skip temp IDs)
  useEffect(() => {
    if (
      currentID &&
      !isTmpSession(currentID) &&
      params.sessionId !== currentID
    ) {
      navigate({
        to: "/chat/$sessionId",
        params: { sessionId: currentID },
        replace: true,
      });
    }
  }, [currentID, params.sessionId, navigate]);

  return (
    <div className="flex h-dvh w-dvw flex-col overflow-hidden bg-background text-foreground">
      <TopBar />
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        {/* Левый сайдбар: плавная анимация ширины на десктопе.
            260px должно совпадать с шириной �� Sidebar.tsx — иначе панель либо
            обрежется, либо оставит пустую полосу. */}
        <div
          className={cn(
            "hidden md:block shrink-0 transition-all duration-300 ease-in-out overflow-hidden",
            sidebarCollapsed ? "w-0 opacity-0" : "w-[260px] opacity-100",
          )}
        >
          <div className="w-[260px] h-full">
            <Sidebar />
          </div>
        </div>
        {/* Мобильная версия сайдбара без анимации контейнера */}
        <div className="md:hidden">
          <Sidebar />
        </div>

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
          <div className="relative flex min-h-0 flex-1 overflow-hidden">
            {/* Chat + Composer — единый блок, который сдвигается при открытии Workspace */}
            <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
              <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
                {serverConnected === false && (
                  <ConnectionBanner onRetry={checkConnection} />
                )}
                {serverConnected !== false && sseDown && (
                  <SseReconnectBanner
                    onRetry={() => streamRef.current?.wake()}
                  />
                )}
                <Outlet />
              </main>

              <Composer />
            </div>

            {/* Мобильный overlay для Workspace — кнопка, а не div:
                тап мимо панели закрывает её и с клавиатуры тоже. */}
            {workspaceOpen && (
              <button
                type="button"
                aria-label={t("router.zakryt_panel_faylov")}
                className="absolute inset-0 z-40 bg-black/50 md:hidden"
                onClick={() => setWorkspaceOpen(false)}
              />
            )}

            {/* Правый сайдбар (Workspace): плавная анимация ширины.
                inert + aria-hidden убирают панель из pointer/focus/accessibility
                tree когда закрыта, чтобы её DOM не перехватывал клики от
                sidebar backdrop или чата. */}
            <div
              inert={!workspaceOpen || undefined}
              aria-hidden={!workspaceOpen}
              className={cn(
                "absolute right-0 top-0 bottom-0 z-50 md:relative shrink-0 transition-all duration-300 ease-in-out overflow-hidden bg-background md:bg-transparent",
                workspaceOpen
                  ? "w-[85vw] max-w-[320px] md:w-80 opacity-100 border-l border-border md:border-none shadow-lg md:shadow-none"
                  : "w-0 opacity-0",
              )}
            >
              <div className="w-[85vw] max-w-[320px] md:w-80 h-full flex flex-col min-h-0">
                <Workspace />
              </div>
            </div>
          </div>
        </div>
      </div>
      {/*
        Этап 2.1: полоса прерываний за флагом `VITE_INTERRUPTION_BAR`.
        Ровно один показ за раз — два одновременно спорили бы за место над
        композером и предлагали бы ответить дважды на одно прерывание.
      */}
      {isInterruptionBarEnabled() ? <InterruptionBar /> : <PermissionDialog />}
      <SettingsPanelHost />
      <ShortcutsOverlay />
      <WelcomeTour />
      <ToastHost />
    </div>
  );
}

function ConnectionBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-b border-amber-500/30",
        "bg-amber-500/10 px-3 py-2 text-sm text-amber-200",
      )}
    >
      <span className="inline-flex items-center gap-2">
        <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
        Нет соединения с Z Agent runtime. Проверьте, что сервер приложения запущен.
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 text-amber-100 hover:bg-amber-500/15 hover:text-amber-50"
        onClick={onRetry}
      >
        Повторить
      </Button>
    </div>
  );
}

function SseReconnectBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-3 border-b border-sky-500/30",
        "bg-sky-500/10 px-3 py-2 text-sm text-sky-200",
      )}
    >
      <span className="inline-flex items-center gap-2">
        <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />
        Потеряно соединение с потоком событий — переподключение…
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 text-sky-100 hover:bg-sky-500/15 hover:text-sky-50"
        onClick={onRetry}
      >
        Переподключить
      </Button>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: () => (
    <ConfirmProvider>
      <AuthGate>
        <AppShell />
      </AuthGate>
      {/* Подсказки по долгому нажатию — замена title= на сенсорном экране. */}
      <TouchHints />
    </ConfirmProvider>
  ),
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: () => <ChatView />,
});

const chatRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/chat/$sessionId",
  component: () => <ChatView />,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});

const routeTree = rootRoute.addChildren([indexRoute, chatRoute, loginRoute]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
