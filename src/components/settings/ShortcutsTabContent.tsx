import { ShortcutsList } from "../ShortcutsOverlay";
import { SettingsSection } from "./primitives";

/**
 * Раздел настроек с горячими клавишами. Список берётся из того же места, что и
 * оверлей по Ctrl+/ — иначе две копии списка со временем разошлись бы.
 */
export function ShortcutsTabContent() {
  return (
    <div className="space-y-6">
      <SettingsSection
        title="Горячие клавиши"
        description="Тот же список открывается в любой момент по Ctrl + / (⌘ + / на Mac)."
      >
        <div className="rounded-xl border border-border bg-card p-3">
          <ShortcutsList />
        </div>
      </SettingsSection>
    </div>
  );
}
