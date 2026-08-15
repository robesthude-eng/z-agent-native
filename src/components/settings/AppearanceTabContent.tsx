import { cn } from "@/lib/utils";
import type { Theme } from "../../config/theme";
import { useStore } from "../../store/useStore";
import { SettingsSection } from "./primitives";

const THEMES: Array<{ id: Theme; label: string; preview: string }> = [
  { id: "dark", label: "Тёмная", preview: "#111214" },
  { id: "mid", label: "Средняя", preview: "#26282c" },
  { id: "light", label: "Светлая", preview: "#f7f7f5" },
];

/** Раздел «Внешний вид»: выбор темы одним кликом (раньше — только циклический тумблер в баре). */
export function AppearanceTabContent() {
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Тема интерфейса"
        description="Применяется сразу и сохраняется на этом устройстве."
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
    </div>
  );
}
