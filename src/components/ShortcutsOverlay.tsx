import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { type MessageKey, t } from "@/i18n";
import { CloseIcon } from "./icons";

/**
 * Шпаргалка по горячим клавишам (Ctrl/Cmd + /).
 *
 * Список составлен по коду обработчиков, а не «как принято»: несуществующий
 * шорткат в справке хуже, чем его отсутствие — пользователь решит, что
 * приложение сломано. Добавляя новый шорткат, добавляйте строку сюда же.
 */
interface ShortcutGroup {
  /*
    Здесь лежат ключи каталога, а не готовые строки: модуль вычисляется
    один раз при импорте — до того, как приложение выберет язык, — и
    переведённые на этом этапе строки застывали навсегда. Перевод
    происходит на рендере, в ShortcutsList.
  */
  title: MessageKey;
  items: { keys: string[]; description: MessageKey }[];
}

/** На Mac принято писать ⌘; определяем платформу один раз при загрузке. */
const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = IS_MAC ? "⌘" : "Ctrl";

const GROUPS: ShortcutGroup[] = [
  {
    title: "shortcuts_overlay.navigaciya",
    items: [
      {
        keys: [MOD, "K"],
        description: "shortcuts_overlay.poisk_po_spisku_chatov",
      },
      {
        keys: [MOD, "Shift", "O"],
        description: "shortcuts_overlay.novyy_chat",
      },
      {
        keys: [MOD, "/"],
        description: "shortcuts_overlay.eta_shpargalka",
      },
      {
        keys: ["Esc"],
        description: "shortcuts_overlay.zakryt_okno_poisk_ili_otmenit_vvod",
      },
    ],
  },
  {
    title: "settings_panel.chat",
    items: [
      {
        keys: ["Enter"],
        description: "composer.otpravit_soobschenie",
      },
      {
        keys: ["Shift", "Enter"],
        description: "shortcuts_overlay.perenos_stroki",
      },
      {
        keys: [MOD, "F"],
        description: "shortcuts_overlay.poisk_po_tekuschemu_chatu",
      },
      {
        keys: [MOD, "Enter"],
        description:
          "shortcuts_overlay.otpravit_otredaktirovannoe_soobschenie_zanov",
      },
      {
        keys: ["Esc"],
        description: "shortcuts_overlay.ostanovit_generaciyu",
      },
      {
        keys: ["↑"],
        description:
          "shortcuts_overlay.vernut_poslednee_soobschenie_v_pole_vvoda",
      },
      {
        keys: ["↑", "↓", "Enter"],
        description: "shortcuts_overlay.vybor_v_podskazkah_komand_i_faylov",
      },
    ],
  },
  {
    title: "workspace.files",
    items: [
      {
        keys: [MOD, "S"],
        description: "shortcuts_overlay.sohranit_otkrytyy_fayl",
      },
      {
        keys: ["Enter"],
        description: "shortcuts_overlay.podtverdit_imya_fayla_ili_papki",
      },
    ],
  },
];

function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {keys.map((key, index) => (
        <span key={key} className="flex items-center gap-1">
          {index > 0 && (
            <span className="text-[10px] text-muted-foreground/60">+</span>
          )}
          <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground">
            {key}
          </kbd>
        </span>
      ))}
    </span>
  );
}

/**
 * Сам список — отдельный компонент: его же показывает раздел настроек,
 * а два независимых списка неизбежно разошлись бы.
 */
export function ShortcutsList() {
  return (
    <div className="space-y-4">
      {GROUPS.map((group) => (
        <section key={group.title} className="space-y-1.5">
          <h3 className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {t(group.title)}
          </h3>
          {group.items.map((item) => (
            <div
              key={`${group.title}:${item.description}`}
              className="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-[12.5px] hover:bg-accent/40"
            >
              <span className="min-w-0 text-muted-foreground">
                {t(item.description)}
              </span>
              <Keys keys={item.keys} />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export default function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      // e.key, а не e.code: «/» на разных раскладках сидит на разных клавишах,
      // а Slash по коду на кириллице даёт точку.
      if (e.key === "/" || e.code === "Slash") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    // Отдельная именованная функция: анонимный обработчик нельзя снять, и
    // подписка копилась бы при каждом перемонтировании.
    const openFromEvent = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("z-agent:shortcuts", openFromEvent);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("z-agent:shortcuts", openFromEvent);
    };
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center p-4">
      {/* Фон — кнопка-сосед, а не родитель с onClick: закрытие кликом мимо
          работает и с клавиатуры, а окну не нужен stopPropagation.
          role="dialog" переехал на само окно, где ему и место. */}
      <button
        type="button"
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={() => setOpen(false)}
        aria-label={t("shortcuts_overlay.zakryt_shpargalku")}
      />
      <div
        className="relative flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-e3"
        role="dialog"
        aria-modal="true"
        aria-label={t("settings_panel.goryachie_klavishi")}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">
            {t("settings_panel.goryachie_klavishi")}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setOpen(false)}
            title={t("panel_modal.zakryt")}
            aria-label={t("panel_modal.zakryt")}
          >
            <CloseIcon size={16} />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <ShortcutsList />
        </div>
      </div>
    </div>
  );
}
