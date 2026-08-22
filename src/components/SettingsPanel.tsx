import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useStore } from "../store/useStore";
import { CloseIcon, SearchIcon } from "./icons";
import { AboutTabContent } from "./settings/AboutTabContent";
import { AccountTabContent } from "./settings/AccountTabContent";
import { AppearanceTabContent } from "./settings/AppearanceTabContent";
import { ModelsTabContent } from "./settings/ModelsTabContent";
import { ShortcutsTabContent } from "./settings/ShortcutsTabContent";
import { t } from "@/i18n";

type SettingsTab =
  | "account"
  | "appearance"
  | "models"
  | "shortcuts"
  | "about";

type TabDef = {
  id: SettingsTab;
  label: string;
  title: string;
  /** Синонимы и ключевые слова раздела для поиска по настройкам. */
  keywords: string;
  /** Раздел виден только администратору. */
  adminOnly?: boolean;
};

type TabGroup = { label: string; items: TabDef[] };

/**
 * Реестр разделов настроек, сгруппированный по смыслу:
 * Аккаунт · Чат · Справка.
 *
 * Как добавить раздел (например «Настройки чата» в группу «Чат»
 * или «Подключение MCP» новой группой «Подключения»):
 * 1. Расширьте тип SettingsTab новым id.
 * 2. Добавьте TabDef в нужную группу (label — пункт меню,
 *    title — заголовок страницы, keywords — слова для поиска).
 * 3. Соберите контент из атомов ./settings/primitives.tsx
 *    (SettingsSection, SettingsRow) и подключите в блоке рендера
 *    контента внизу этого файла.
 */
const TAB_GROUPS: TabGroup[] = [
  {
    label: t("settings_panel.akkaunt"),
    items: [
      {
        id: "account",
        label: t("settings_panel.akkaunt_i_parol"),
        title: t("settings_panel.akkaunt_i_parol"),
        keywords:
          t("settings_panel.akkaunt_profil_email_parol_smenit_smena"),
      },
      {
        id: "appearance",
        label: t("settings_panel.vneshniy_vid"),
        title: t("settings_panel.vneshniy_vid"),
        keywords:
          t("settings_panel.tema_cvet_temnaya_svetlaya_srednyaya_oformle"),
      },
    ],
  },
  {
    label: t("settings_panel.chat"),
    items: [
      {
        id: "models",
        label: t("settings_panel.modeli"),
        title: t("settings_panel.modeli_i_api_klyuchi"),
        keywords:
          t("settings_panel.modeli_klyuch_provaydery_api_byok_models"),
      },
    ],
  },
  {
    label: t("settings_panel.spravka"),
    items: [
      {
        id: "shortcuts",
        label: t("settings_panel.goryachie_klavishi"),
        title: t("settings_panel.goryachie_klavishi"),
        keywords:
          t("settings_panel.goryachie_klavishi_shortkaty_sochetaniya_hot"),
      },
      {
        id: "about",
        label: t("settings_panel.o_sisteme"),
        title: t("settings_panel.o_sisteme_i_arhitekture"),
        keywords: t("settings_panel.versiya_stek_arhitektura_spravka_about_versi"),
      },
    ],
  },
];

const ALL_TABS: TabDef[] = TAB_GROUPS.flatMap((g) => g.items);

/**
 * Thin shell: owns only nav/search/mobile UI state and the modal markup.
 * All domain logic and presentational card markup live in `./settings/*`.
 */
export default function SettingsPanel() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const loadAuth = useStore((s) => s.loadAuth);

  const [activeTab, setActiveTab] = useState<SettingsTab>("models");
  const [query, setQuery] = useState("");
  // Mobile: "menu" shows nav list; "content" shows selected tab with Back
  const [mobileView, setMobileView] = useState<"menu" | "content">("menu");
  const panelRef = useRef<HTMLDivElement | null>(null);


  // UX-fix: reset mobileView/search + reload auth ТОЛЬКО когда open переключается
  // false→true, а НЕ на каждый ре-рендер стора.
  const prevOpenRef = useRef(false);
  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setMobileView("menu");
      setQuery("");
      loadAuth();
    }
    prevOpenRef.current = open;
  }, [open, loadAuth]);

  // Закрытие по Escape (как у PanelModal) + перенос фокуса внутрь модалки (a11y).
  useEffect(() => {
    if (!open) return;
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  // Группы меню: скрываем админские разделы у обычных пользователей
  // и фильтруем по поисковому запросу (label + title + keywords).
  const visibleGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return TAB_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter(
        (t) =>
          (!q ||
            t.label.toLowerCase().includes(q) ||
            t.title.toLowerCase().includes(q) ||
            t.keywords.includes(q)),
      ),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  if (!open) return null;

  const tabTitle = ALL_TABS.find((t) => t.id === activeTab)?.title ?? "";

  const searchBox = (
    <div className="relative">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
        <SearchIcon size={14} />
      </span>
      <Input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("settings_panel.poisk_nastroek")}
        aria-label={t("settings_panel.poisk_po_nastroykam")}
        className="h-8 pl-8 text-sm"
      />
    </div>
  );

  const emptyResults = (
    <p className="px-3 py-2 text-xs text-muted-foreground">{t("settings_panel.nichego_ne_naydeno")}</p>
  );

  return (
    // Фон нельзя вынести в соседнюю кнопку, как в PanelModal: тест
    // «closes panel when clicking overlay» кликает по самому .overlay.
    // Поэтому onClick остаётся здесь, но срабатывает только на самом фоне —
    // так окну не нужен stopPropagation.
    // biome-ignore lint/a11y/noStaticElementInteractions: фон декоративен (role="presentation"); закрытие с клавиатуры уже есть — Escape (см. эффект выше) и кнопки «Закрыть» в шапках
    <div
      className="overlay fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-stretch sm:items-center justify-center p-0 sm:p-4"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) setOpen(false);
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("settings_panel.nastroyki")}
        tabIndex={-1}
        className="bg-background border-0 sm:border border-border rounded-none sm:rounded-2xl shadow-e3 w-full sm:max-w-5xl h-[100dvh] sm:h-[min(700px,88vh)] flex overflow-hidden outline-none"
      >
        {/* Desktop sidebar */}
        <aside className="hidden md:flex w-64 border-r border-border bg-muted/20 p-3 flex-col gap-3 shrink-0">
          <div className="flex items-center justify-between px-2 pt-1">
            <h2 className="text-base font-semibold">{t("settings_panel.nastroyki")}</h2>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => setOpen(false)}
              type="button"
              title={t("panel_modal.zakryt")}
            >
              <CloseIcon />
            </Button>
          </div>
          <div className="px-1">{searchBox}</div>
          <nav className="flex flex-col gap-4 overflow-y-auto px-1 pb-2">
            {visibleGroups.length === 0 && emptyResults}
            {visibleGroups.map((g) => (
              <div key={g.label} className="flex flex-col gap-0.5">
                {g.items.map((tab) => (
                  <button
                    key={tab.id}
                    className={cn(
                      "w-full rounded-lg px-2.5 py-1.5 text-left text-[13px] transition",
                      activeTab === tab.id
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                    onClick={() => setActiveTab(tab.id)}
                    aria-current={activeTab === tab.id ? "page" : undefined}
                    type="button"
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </aside>

        {/* Mobile: menu list */}
        <div
          className={cn(
            "flex-1 flex-col min-w-0 md:hidden",
            mobileView === "menu" ? "flex" : "hidden",
          )}
        >
          <header className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0 safe-top">
            <h2 className="text-lg font-semibold">{t("settings_panel.nastroyki")}</h2>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9"
              onClick={() => setOpen(false)}
              type="button"
              title={t("panel_modal.zakryt")}
            >
              <CloseIcon />
            </Button>
          </header>
          <nav className="flex-1 overflow-y-auto p-3 space-y-4">
            {searchBox}
            {visibleGroups.length === 0 && emptyResults}
            {visibleGroups.map((g) => (
              <div key={g.label} className="space-y-1">
                {g.items.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-[15px] hover:bg-muted/60 active:bg-muted transition"
                    onClick={() => {
                      setActiveTab(tab.id);
                      setMobileView("content");
                    }}
                  >
                    <span className="flex-1 font-medium">{tab.label}</span>
                    <span className="text-muted-foreground">›</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </div>

        {/* Content (desktop always; mobile when content view) */}
        <div
          className={cn(
            "flex-1 flex-col min-w-0",
            mobileView === "content" ? "flex" : "hidden md:flex",
          )}
        >
          <header className="flex items-center gap-2 px-3 sm:px-5 py-3 sm:py-4 border-b border-border shrink-0 safe-top">
            <Button
              variant="ghost"
              size="sm"
              className="md:hidden h-9 px-2 shrink-0"
              onClick={() => setMobileView("menu")}
              type="button"
            >
              ← Назад
            </Button>
            <h3 className="font-semibold text-[15px] sm:text-base flex-1 min-w-0 truncate">
              {tabTitle}
            </h3>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={() => setOpen(false)}
              title={t("panel_modal.zakryt")}
              type="button"
            >
              <CloseIcon />
            </Button>
          </header>

          <div className="flex-1 overflow-y-auto p-4 sm:p-6 pb-10">
            <div className="mx-auto w-full max-w-3xl">
              {activeTab === "account" && <AccountTabContent />}
              {activeTab === "appearance" && <AppearanceTabContent />}
              {activeTab === "models" && <ModelsTabContent />}
              {activeTab === "shortcuts" && <ShortcutsTabContent />}
              {activeTab === "about" && <AboutTabContent />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
