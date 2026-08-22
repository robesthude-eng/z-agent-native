import { cn } from "@/lib/utils";
import type { Theme } from "../../config/theme";
import { useStore } from "../../store/useStore";
import { SettingsSection } from "./primitives";
import { t } from "@/i18n";

/** Мини-превью темы: фон окна, полоса сайдбара и цвет строк текста. */
const THEMES: Array<{
  id: Theme;
  label: string;
  preview: string;
  sidebar: string;
  line: string;
}> = [
  {
    id: "dark",
    label: t("appearance_tab_content.temnaya"),
    preview: "#111214",
    sidebar: "#191b1e",
    line: "#8b8f93",
  },
  {
    id: "mid",
    label: t("appearance_tab_content.srednyaya"),
    preview: "#26282c",
    sidebar: "#2c2f33",
    line: "#a7abaf",
  },
  {
    id: "light",
    label: t("appearance_tab_content.svetlaya"),
    preview: "#f7f7f5",
    sidebar: "#ffffff",
    line: "#6f7275",
  },
];

/** Раздел «Внешний вид»: выбор темы одним кликом (раньше — только циклический тумблер в баре). */
export function AppearanceTabContent() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);

  return (
    <div className="space-y-6">
      <SettingsSection
        title={t("appearance_tab_content.tema_interfeysa")}
        description={t("appearance_tab_content.primenyaetsya_srazu_i_sohranyaetsya_na_etom")}
      >
        <div className="grid max-w-md grid-cols-3 gap-3">
          {/* Параметр назывался `t` и затенял функцию перевода внутри карточки. */}
          {THEMES.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setTheme(item.id)}
              aria-pressed={theme === item.id}
              className={cn(
                "rounded-xl border p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/60",
                theme === item.id
                  ? "border-primary ring-1 ring-primary"
                  : "border-border hover:bg-accent",
              )}
            >
              {/* Был просто прямоугольник цвета фона — по нему нельзя было
                  понять контраст текста. Теперь это мини-макет окна. */}
              <span
                className="mb-2 flex h-12 w-full gap-1 overflow-hidden rounded-lg border border-border p-1"
                style={{ background: item.preview }}
              >
                <span
                  className="h-full w-1/3 rounded"
                  style={{ background: item.sidebar }}
                />
                <span className="flex flex-1 flex-col justify-center gap-1">
                  <span
                    className="block h-1.5 w-full rounded-full"
                    style={{ background: item.line }}
                  />
                  <span
                    className="block h-1.5 w-2/3 rounded-full"
                    style={{ background: item.line, opacity: 0.6 }}
                  />
                </span>
              </span>
              <span className="text-sm font-medium">{item.label}</span>
            </button>
          ))}
        </div>
      </SettingsSection>
    </div>
  );
}
