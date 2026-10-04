import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import type { ChatWidth, FontScale } from "../../config/appSettings";
import type { Theme } from "../../config/theme";
import { useStore } from "../../store/useStore";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsToggle,
} from "./primitives";

const FONT_OPTIONS: Array<{ id: FontScale; label: string }> = [
  { id: "sm", label: "Мелкий" },
  { id: "md", label: "Обычный" },
  { id: "lg", label: "Крупный" },
  { id: "xl", label: "Очень крупный" },
];

const WIDTH_OPTIONS: Array<{ id: ChatWidth; label: string }> = [
  { id: "narrow", label: "Узкая" },
  { id: "normal", label: "Обычная" },
  { id: "wide", label: "Широкая" },
  { id: "full", label: "Во всю ширину" },
];

const THEMES: Array<{ id: Theme; label: string; preview: string }> = [
  {
    id: "dark",
    label: t("appearance_tab_content.temnaya"),
    preview: "#111214",
  },
  {
    id: "mid",
    label: t("appearance_tab_content.srednyaya"),
    preview: "#26282c",
  },
  {
    id: "light",
    label: t("appearance_tab_content.svetlaya"),
    preview: "#f7f7f5",
  },
];

/** Раздел «Внешний вид»: выбор темы одним кликом (раньше — только циклический тумблер в баре). */
export function AppearanceTabContent() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const settings = useStore((s) => s.appSettings);
  const update = useStore((s) => s.setAppSettings);

  return (
    <div className="space-y-6">
      <SettingsSection
        title={t("appearance_tab_content.tema_interfeysa")}
        description={t(
          "appearance_tab_content.primenyaetsya_srazu_i_sohranyaetsya_na_etom",
        )}
      >
        <div className="grid max-w-md grid-cols-3 gap-3">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTheme(t.id)}
              aria-pressed={theme === t.id}
              className={cn(
                "rounded-xl border p-3 text-left transition",
                theme === t.id
                  ? "border-primary ring-1 ring-primary"
                  : "border-border hover:bg-accent",
              )}
            >
              <span
                className="mb-2 block h-10 w-full rounded-lg border border-border"
                style={{ background: t.preview }}
              />
              <span className="text-sm font-medium">{t.label}</span>
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Текст и раскладка"
        description="Сохраняется в аккаунте и применяется на всех устройствах."
      >
        <SettingsCard>
          <SettingsRow
            label="Размер шрифта"
            description="Масштабирует весь интерфейс, включая чат."
          >
            <SettingsSegmented
              ariaLabel="Размер шрифта"
              value={settings.fontScale}
              options={FONT_OPTIONS}
              onChange={(fontScale) => update({ fontScale })}
            />
          </SettingsRow>
          <SettingsRow
            label="Ширина чата"
            description="Максимальная ширина ленты сообщений и поля ввода."
          >
            <SettingsSegmented
              ariaLabel="Ширина чата"
              value={settings.chatWidth}
              options={WIDTH_OPTIONS}
              onChange={(chatWidth) => update({ chatWidth })}
            />
          </SettingsRow>
          <SettingsRow
            label="Меньше анимаций"
            description="Отключает плавные переходы и анимации — быстрее на слабых устройствах."
          >
            <SettingsToggle
              ariaLabel="Меньше анимаций"
              checked={settings.reduceMotion}
              onChange={(reduceMotion) => update({ reduceMotion })}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
