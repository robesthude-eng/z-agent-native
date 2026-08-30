import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useShallow } from "zustand/react/shallow";
import { Button } from "@/components/ui/button";
import { t, tf } from "@/i18n";
import { errorMessage, isAbortedError, statusText } from "../api/eventGuards";
import {
  dispositionOf,
  indicatorFor,
  STUCK_ACTION,
  STUCK_NOTICE,
  VERDICT_POLL_MS,
} from "../api/turnVerdict";
import type { Message } from "../api/types";
import { describeAgentActivity } from "../lib/agentActivity";
import { messageText } from "../lib/chatText";
import { isTmpSession } from "../lib/ids";
import { useStore } from "../store/useStore";
import AgentIndicator from "./AgentIndicator";
import {
  BashIcon,
  BookIcon,
  BugIcon,
  ChevronDownIcon,
  FilePlusIcon,
} from "./icons";
import MessageItem from "./MessageItem";

/*
  Карточки-подсказки собираются на рендере, а не при импорте модуля: t()
  на верхнем уровне выполняется до того, как приложение выберет язык, и
  подписи застывали в том языке, который успел загрузиться первым.
*/
const suggestionCards = () => [
  {
    title: t("chat_view.sobrat_proekt"),
    prompt: t("chat_view.sozday_v_workspace_staticheskuyu_stranicu_le"),
    icon: FilePlusIcon,
  },
  {
    title: t("chat_view.razobrat_kod"),
    prompt: t("chat_view.obyasni_chto_delaet_etot_kod_i"),
    icon: BookIcon,
  },
  {
    title: t("chat_view.nayti_bag"),
    prompt: t("chat_view.v_kode_nizhe_est_oshibka_naydi"),
    icon: BugIcon,
  },
  {
    title: t("chat_view.proverit_okruzhenie"),
    prompt: t("chat_view.pokazhi_v_terminale_versii_node_npm"),
    icon: BashIcon,
  },
];

/**
 * Курсор в поле ввода? Тогда Ctrl/⌘+F — это поиск внутри самого поля
 * (терминал, редактор файла, поиск по списку чатов), и перехватывать его
 * нельзя: приложение выглядело сломанным именно из-за этого.
 */
const isTextEntry = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

const hasVisibleContent = (m: Message) =>
  m.role === "assistant" &&
  m.parts.some(
    (p) =>
      (p.type === "text" && (p as { text?: string }).text) ||
      p.type === "tool" ||
      p.type === "reasoning",
  );

export default function ChatView() {
  const currentID = useStore((s) => s.currentID);
  const messages = useStore(
    useShallow((s) => (currentID ? s.messages[currentID] : undefined)),
  );
  const rawStatus = useStore((s) =>
    currentID ? s.status[currentID] : undefined,
  );
  const status = statusText(rawStatus);
  const projection = useStore((s) =>
    currentID ? (s.turnProjection[currentID] ?? null) : null,
  );
  const projectionDisposition = projection ? dispositionOf(projection) : null;
  const indicator = indicatorFor(projectionDisposition);
  const showWorking =
    indicator.kind === "unknown"
      ? status === "busy"
      : indicator.kind === "working";
  const unresolved =
    indicator.kind === "unresolved"
      ? { notice: indicator.notice, action: indicator.action }
      : indicator.kind === "unknown" &&
          (status === "stale" || status === "orphaned")
        ? { notice: STUCK_NOTICE, action: STUCK_ACTION }
        : null;

  const error = useStore((s) => s.error);
  const refreshTurnProjection = useStore((s) => s.refreshTurnProjection);
  const prefillComposer = useStore((s) => s.prefillComposer);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  /*
    Прокрутка, которую сделали мы сами: её нельзя принимать за жест
    пользователя, иначе лента отцеплялась бы от низа на собственных
    подскроллах во время стрима.
  */
  const programmaticRef = useRef(false);
  const lastTopRef = useRef(0);
  const smoothUntilRef = useRef(0);
  const unreadAssistantIdsRef = useRef<Set<string>>(new Set());
  const [newAnswerCount, setNewAnswerCount] = useState(0);
  const [windowSize, setWindowSize] = useState(40);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  const pendingAnchorRef = useRef<{ top: number; height: number } | null>(null);
  const [isScrolledUp, setIsScrolledUp] = useState(false);

  // Release A / Trust: a browser reload must not erase a server-side running
  // turn. Read the authoritative projection immediately, then keep watching
  // only while the turn is active/uncertain. Visibility and online events
  // trigger an immediate reconciliation after mobile sleep or network loss.
  useEffect(() => {
    if (!currentID || isTmpSession(currentID)) return;
    let disposed = false;
    const sync = () => {
      if (disposed || document.hidden) return;
      void refreshTurnProjection(currentID);
    };

    sync();
    const shouldWatch =
      status === "busy" ||
      status === "stale" ||
      status === "orphaned" ||
      projectionDisposition === "busy" ||
      projectionDisposition === "waiting" ||
      projectionDisposition === "stuck";
    if (!shouldWatch) return;

    const timer = window.setInterval(sync, VERDICT_POLL_MS);
    const onVisibility = () => {
      if (!document.hidden) sync();
    };
    const onOnline = () => sync();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, [currentID, projectionDisposition, refreshTurnProjection, status]);

  const resetNewAnswers = useCallback(() => {
    unreadAssistantIdsRef.current.clear();
    setNewAnswerCount(0);
  }, []);

  /*
    scrollIntoView прокручивает всех предков сразу — на мобильных вместе с
    лентой уезжала вся страница. Двигаем только сам контейнер.
    smoothUntilRef держит окно анимации: прилипание к низу не должно рвать
    её мгновенным прыжком.
  */
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      programmaticRef.current = true;
      smoothUntilRef.current = Date.now() + 600;
      if (typeof el.scrollTo === "function") {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      } else {
        el.scrollTop = el.scrollHeight;
      }
    }
    atBottomRef.current = true;
    setIsScrolledUp(false);
    resetNewAnswers();
  }, [resetNewAnswers]);

  useEffect(() => {
    atBottomRef.current = true;
    lastTopRef.current = 0;
    programmaticRef.current = false;
    smoothUntilRef.current = 0;
    setIsScrolledUp(false);
    resetNewAnswers();
  }, [currentID, resetNewAnswers]);

  const scrollRafRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(
    null,
  );
  /*
    «Внизу ли мы» раньше решалось только расстоянием до дна (80px). Во время
    стрима это значило, что подкрутить ленту на 20-30px вверх невозможно:
    следующий же чанк утягивал обратно. Теперь любое движение вверх сразу
    отцепляет автопрокрутку, а прилипание возвращается, когда пользователь
    сам довёл ленту до дна. Собственные подскроллы помечены programmaticRef
    и за жест не считаются.
  */
  const onScroll = () => {
    if (scrollRafRef.current) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const el = scrollRef.current;
      if (!el) return;
      const top = el.scrollTop;
      const distance = el.scrollHeight - top - el.clientHeight;
      const movedUp = top < lastTopRef.current - 1;
      lastTopRef.current = top;
      if (programmaticRef.current) programmaticRef.current = false;
      else if (movedUp) atBottomRef.current = false;
      if (distance <= 8) atBottomRef.current = true;
      const isUp = distance >= 80;
      if (!isUp && unreadAssistantIdsRef.current.size > 0) resetNewAnswers();
      if (isScrolledUp !== isUp) setIsScrolledUp(isUp);
    });
  };

  const showScrollBtn = isScrolledUp && messages && messages.length > 0;

  const streamSignal = useMemo(() => {
    if (!messages || messages.length === 0) return "";
    const last = messages[messages.length - 1];
    const textLen =
      last?.parts?.reduce((n, p) => {
        const anyP = p as {
          text?: string;
          state?: { output?: unknown } | string;
        };
        const state =
          typeof anyP.state === "object" && anyP.state !== null
            ? anyP.state
            : undefined;
        const outLen =
          typeof state?.output === "string" ? state.output.length : 0;
        return n + (anyP.text?.length ?? 0) + outLen;
      }, 0) ?? 0;
    return `${messages.length}:${last?.id ?? ""}:${last?.parts?.length ?? 0}:${textLen}`;
  }, [messages]);

  const pinRafRef = useRef<ReturnType<typeof requestAnimationFrame> | null>(
    null,
  );
  /*
    Одно прилипание к низу на кадр — и на приход чанка, и на рост высоты.
  */
  const pinToBottom = useCallback(() => {
    if (!atBottomRef.current) return;
    if (pinRafRef.current !== null) return;
    pinRafRef.current = requestAnimationFrame(() => {
      pinRafRef.current = null;
      const el = scrollRef.current;
      if (!el || !atBottomRef.current) return;
      // Плавная прокрутка кнопкой «вниз» ещё идёт — не рвать её прыжком.
      if (Date.now() < smoothUntilRef.current) return;
      programmaticRef.current = true;
      el.scrollTop = el.scrollHeight;
    });
  }, []);

  useEffect(() => {
    if (!streamSignal) return;
    pinToBottom();
  }, [streamSignal, pinToBottom]);

  /*
    Высота ленты растёт не только от новых чанков: typewriter открывает текст
    по кускам между ними, раскрываются карточки инструментов, догружаются
    картинки и подсветка кода. Подписка на сам стрим всего этого не видит —
    поэтому раньше текст уползал под нижний край, а следующий чанк рывком
    возвращал его на место. ResizeObserver ловит любой рост высоты.
    rAF внутри обязателен: правка scrollTop прямо в колбэке даёт
    «ResizeObserver loop completed with undelivered notifications».
  */
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const node = contentRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => pinToBottom());
    observer.observe(node);
    return () => observer.disconnect();
  }, [currentID, pinToBottom]);

  useEffect(() => {
    if (!streamSignal || atBottomRef.current || !messages?.length) return;
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role !== "assistant" || !hasVisibleContent(message))
        continue;
      if (!unreadAssistantIdsRef.current.has(message.id)) {
        unreadAssistantIdsRef.current.add(message.id);
        setNewAnswerCount(unreadAssistantIdsRef.current.size);
      }
      break;
    }
  }, [streamSignal, messages]);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current);
      if (pinRafRef.current !== null) {
        cancelAnimationFrame(pinRafRef.current);
      }
    };
  }, []);

  const lastMsg = messages?.[messages.length - 1];
  const lastHasContent = lastMsg ? hasVisibleContent(lastMsg) : false;
  const showTyping = showWorking && !lastHasContent;

  const visibleMessages = useMemo(
    () =>
      (messages || []).filter(
        (m) => !showTyping || m.role !== "assistant" || hasVisibleContent(m),
      ),
    [messages, showTyping],
  );

  const groupedMessages = useMemo(() => {
    const groups: { role: string; messages: Message[] }[] = [];
    for (const m of visibleMessages) {
      const lastGroup = groups[groups.length - 1];
      if (lastGroup && lastGroup.role === m.role && m.role === "assistant") {
        lastGroup.messages.push(m);
      } else {
        groups.push({ role: m.role, messages: [m] });
      }
    }
    return groups;
  }, [visibleMessages]);

  const isWindowed = groupedMessages.length > windowSize;
  const renderedGroups = useMemo(
    () => (isWindowed ? groupedMessages.slice(-windowSize) : groupedMessages),
    [groupedMessages, isWindowed, windowSize],
  );

  /**
   * Рост окна истории с сохранением места чтения.
   *
   * Группы добавляются СВЕРХУ, и без поправки лента уезжала бы вниз на
   * их суммарную высоту — прочитанное место теряется, а автодогрузка ниже
   * сразу же срабатывала бы снова. Замер снимается до отрисовки,
   * восстановление — в useLayoutEffect ниже, до кадра, чтобы прыжок не ��ыл
   * виден. На браузерное scroll anchoring не полагаемся: оно отключается
   * тем самым `content-visibility`, ради которого всё затевалось.
   */
  const growWindow = useCallback(() => {
    const root = scrollRef.current;
    if (root) {
      pendingAnchorRef.current = {
        top: root.scrollTop,
        height: root.scrollHeight,
      };
    }
    setWindowSize((s) => s + 40);
  }, []);

  useLayoutEffect(() => {
    const root = scrollRef.current;
    const anchor = pendingAnchorRef.current;
    pendingAnchorRef.current = null;
    if (!root || !anchor) return;
    root.scrollTop = anchor.top + (root.scrollHeight - anchor.height);
  }, [windowSize]);

  /**
   * Автодогрузка истории при прокрутке вверх.
   *
   * Кнопка «Показать предыдущие» остаётся: она и явное управление, и
   * единственный путь там, где IntersectionObserver нет (jsdom в тестах,
   * старые браузеры). Наблюдатель лишь избавляет от клика: сентинел
   * висит над первой группой, и окно растёт за 600px до края — пока
   * старые сообщения ещё не нужны глазу.
   */
  useEffect(() => {
    if (!isWindowed) return;
    if (typeof IntersectionObserver === "undefined") return;
    const node = loadMoreRef.current;
    const root = scrollRef.current;
    if (!node || !root) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) growWindow();
      },
      { root, rootMargin: "600px 0px 0px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [isWindowed, windowSize, growWindow]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIdx, setSearchIdx] = useState(0);

  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    return (messages || [])
      .filter((m) => messageText(m).toLowerCase().includes(q))
      .map((m) => m.id);
  }, [messages, searchQuery]);

  /**
   * Прыжок к найденному сообщению.
   *
   * `[data-mids~="..."]` — селектор по слову в атрибуте, а id сообщений
   * содержат точки и двоеточия: любой такой id ломал селектор, и поиск
   * молча не находил собственную цель. Сравниваем строки перебором.
   *
   * Окно раскрывается ровно до нужной группы, а не до 100000: раскрытие всей
   * истории разом рисует тысячи сообщений и вешает вкладку на секунды.
   */
  const jumpToMessage = (mid: string) => {
    const find = () => {
      const root = scrollRef.current;
      if (!root) return null;
      const nodes = Array.from(
        root.querySelectorAll<HTMLElement>("[data-mids]"),
      );
      for (const node of nodes) {
        const mids = node.dataset.mids;
        if (mids && mids.split(" ").includes(mid)) return node;
      }
      return null;
    };
    const el = find();
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    const index = groupedMessages.findIndex((group) =>
      group.messages.some((m) => m.id === mid),
    );
    if (index >= 0) {
      const needed = groupedMessages.length - index;
      setWindowSize((size) => (size >= needed ? size : needed + 5));
    }
    setTimeout(() => {
      find()?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 80);
  };

  const goToMatch = (idx: number) => {
    const total = searchMatches.length;
    if (total === 0) return;
    const n = ((idx % total) + total) % total;
    setSearchIdx(n);
    const mid = searchMatches[n];
    if (mid) jumpToMessage(mid);
  };

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const wasWorkingRef = useRef(false);

  useEffect(() => {
    const openSearch = () => setSearchOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.code !== "KeyF") return;
      /*
        Без открытого чата искать нечего, а в поле ввода Ctrl/⌘+F должен
        искать по самому полю: раньше мы отбирали его у терминала,
        редактора файлов и поиска по списку чатов.
      */
      if (!currentID || isTextEntry(e.target)) return;
      e.preventDefault();
      openSearch();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("z-agent:chat-search", openSearch);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("z-agent:chat-search", openSearch);
    };
  }, [currentID]);

  /*
    Фокус в поле поиска ставится один раз — при открытии. Прежний
    `ref={(el) => el?.focus()}` вызывался на каждом рендере, то есть на
    каждом токене стрима: курсор возвращался в поле и сбрасывал выделение.
  */
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  /*
    Лента объявлена как role="log" с aria-live="off": читать вслух каждый
    токен нельзя. Вместо этого — ровно одна короткая фраза на завершение
    хода и на ошибку, в отдельной невидимой области ниже.
  */
  useEffect(() => {
    if (showTyping) {
      wasWorkingRef.current = true;
      return;
    }
    if (!wasWorkingRef.current) return;
    wasWorkingRef.current = false;
    setAnnouncement(t("chat_view.otvet_agenta_gotov"));
  }, [showTyping]);

  useEffect(() => {
    const text = errorMessage(error);
    if (text) setAnnouncement(tf("chat_view.oshibka_0", [text]));
  }, [error]);

  const hasLocalAssistantError = useMemo(
    () =>
      (messages || []).some(
        (m) =>
          m.role === "assistant" &&
          m.info?.error &&
          !isAbortedError(m.info.error),
      ),
    [messages],
  );

  if (!currentID) {
    return (
      <div className="flex-1 flex items-center justify-center p-4 md:p-6 min-h-0 overflow-y-auto">
        <div className="max-w-3xl w-full text-center px-3 md:px-6">
          <h1 className="text-xl md:text-3xl font-semibold mb-2">
            {t("chat_view.chem_mogu_pomoch")}
          </h1>
          <p className="text-sm md:text-base text-muted-foreground">
            {t("chat_view.tvoy_personalnyy_ai_assistent_dlya_koda")}
          </p>
          <div className="mt-6 grid grid-cols-1 gap-2 text-left sm:grid-cols-2">
            {suggestionCards().map((s) => (
              <button
                key={s.title}
                type="button"
                className="flex items-start gap-3 rounded-2xl bg-card px-4 py-3 transition hover:bg-accent"
                onClick={() => prefillComposer(s.prompt)}
              >
                <span
                  className="mt-0.5 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                >
                  <s.icon size={16} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{s.title}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {s.prompt.trim().split("\n")[0]}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 relative min-h-0 overflow-hidden bg-transparent">
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: длинную историю нужно листать с клавиатуры, а не только колесом мыши */}
      <div
        key={currentID}
        role="log"
        aria-live="off"
        aria-label={t("chat_view.lenta_soobscheniy_chata")}
        tabIndex={0}
        className="oc-chat-in oc-scroll-subtle h-full overflow-y-auto pb-6 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring/40"
        ref={scrollRef}
        onScroll={onScroll}
      >
        {error && !hasLocalAssistantError && (
          <div className="mx-auto max-w-3xl px-3 md:px-6 pt-3">
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {/* JSON.stringify(Error) возвращает "{}": плашка ошибки
                  оказывалась пустой. errorMessage() достаёт текст из любой
                  формы ошибки, которую отдают сервер и SDK. */}
              {errorMessage(error) ?? t("changes_panel.oshibka")}
            </div>
          </div>
        )}
        <div ref={contentRef} className="mx-auto max-w-3xl">
          {(!messages || messages.length === 0) && status !== "busy" && (
            <p className="text-center text-muted-foreground py-12">
              {t("chat_view.nachni_dialog_napishi_soobschenie_nizhe")}
            </p>
          )}
          {isWindowed && (
            <div className="text-center py-3">
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full text-muted-foreground hover:text-foreground"
                onClick={growWindow}
              >
                {/*
                  Окно режется по ГРУППАМ, а счётчик считался по сообщениям:
                  кнопка обещала «ещё 120», хотя скрыто было 30 групп.
                */}
                {tf("chat_view.pokazat_predyduschie_soobscheniya_0", [
                  groupedMessages.length - windowSize,
                ])}
              </Button>
            </div>
          )}
          {isWindowed && (
            <div ref={loadMoreRef} aria-hidden="true" className="h-px" />
          )}
          <div>
            {renderedGroups.map((group, i) => {
              const isWorking =
                showWorking &&
                group.role === "assistant" &&
                i === renderedGroups.length - 1;
              const firstId = group.messages[0]?.id ?? `group-${i}`;
              const mids = group.messages.map((m) => m.id).join(" ");
              return (
                <div
                  key={`${group.role}:${firstId}`}
                  data-mids={mids}
                  className="oc-msg-group"
                >
                  <MessageItem
                    messages={group.messages}
                    isWorking={isWorking}
                    isLatest={i === renderedGroups.length - 1}
                  />
                </div>
              );
            })}
            {showWorking && (
              <div className="flex gap-3 py-3 px-3 md:px-6">
                <AgentIndicator activity={describeAgentActivity(messages)} />
              </div>
            )}
            {unresolved && (
              <div className="flex flex-wrap items-center gap-3 py-5 px-3 md:px-6">
                <span className="text-muted-foreground">
                  {unresolved.notice}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-full text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    if (currentID) refreshTurnProjection(currentID);
                  }}
                >
                  {unresolved.action}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
      {/*
        Единственное объявление на весь ход: сама лента молчит, иначе
        скринридер зачитывал бы каждый токен стрима.
      */}
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {searchOpen && (
        <div className="absolute right-3 top-2 z-20 flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1 shadow-e2">
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setSearchIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") goToMatch(searchIdx + 1);
              if (e.key === "Escape") setSearchOpen(false);
            }}
            placeholder={t("chat_view.poisk_po_chatu")}
            aria-label={t("chat_view.poisk_po_soobscheniyam_chata")}
            className="w-40 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {searchMatches.length > 0
              ? `${(searchIdx % searchMatches.length) + 1}/${searchMatches.length}`
              : "0/0"}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title={t("chat_view.predyduschee_sovpadenie")}
            aria-label={t("chat_view.predyduschee_sovpadenie")}
            onClick={() => goToMatch(searchIdx - 1)}
          >
            ↑
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title={t("chat_view.sleduyuschee_sovpadenie")}
            aria-label={t("chat_view.sleduyuschee_sovpadenie")}
            onClick={() => goToMatch(searchIdx + 1)}
          >
            ↓
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            title={t("chat_view.zakryt_poisk")}
            aria-label={t("chat_view.zakryt_poisk")}
            onClick={() => setSearchOpen(false)}
          >
            ✕
          </Button>
        </div>
      )}
      {showScrollBtn && (
        <button
          type="button"
          className="absolute bottom-3 left-1/2 flex min-h-10 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-card px-3 py-2 text-xs text-muted-foreground shadow-e2 transition hover:bg-muted hover:text-foreground"
          onClick={scrollToBottom}
          title={t("chat_view.k_poslednemu_soobscheniyu")}
          aria-label={
            newAnswerCount > 0
              ? newAnswerCount === 1
                ? t("chat_view.k_novomu_otvetu")
                : tf("chat_view.k_novym_otvetam_0", [newAnswerCount])
              : t("chat_view.k_poslednemu_soobscheniyu")
          }
        >
          <ChevronDownIcon size={17} />
          {newAnswerCount > 0 && (
            <span>
              {newAnswerCount === 1
                ? t("chat_view.novyy_otvet")
                : tf("chat_view.0_novyh", [newAnswerCount])}
            </span>
          )}
        </button>
      )}
    </div>
  );
}
