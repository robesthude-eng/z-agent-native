import { ShortcutsList } from "../ShortcutsOverlay";
import { SettingsSection } from "./primitives";
import { t } from "@/i18n";

/**
 * Раздел настроек с горячими клавишами. Список берётся из того же места, что и
 * оверлей по Ctrl+/ — иначе две копии списка со временем разошлись бы.
 */
export function ShortcutsTabContent() {
  return (
    <div className="space-y-6">
      <SettingsSection
        title={t("settings_panel.goryachie_klavishi")}
        description={t("shortcuts_tab_content.tot_zhe_spisok_otkryvaetsya_v_lyuboy")}
      >
        <div className="rounded-xl border border-border bg-card p-3">
          <ShortcutsList />
        </div>
      </SettingsSection>
    </div>
  );
}
