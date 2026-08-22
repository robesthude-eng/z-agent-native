import { WarningIcon } from "../icons";
import { SettingsCard, SettingsSection } from "./primitives";
import { t } from "@/i18n";

const ABOUT_ROWS: Array<[string, string]> = [
  [t("about_tab_content.versiya"), "Z Agent Native v1"],
  ["Runtime", t("about_tab_content.sobstvennyy_agent_loop_sessions_tools_questi")],
  [t("settings_panel.modeli"), "OpenAI-compatible · Anthropic · Google Gemini · custom endpoints"],
  ["Workspace", t("about_tab_content.izolirovannyy_katalog_na_chat_files_terminal")],
  [t("about_tab_content.hranilische"), "SQLite z-agent.sqlite · owner-scoped sessions, keys, models, preferences"],
  [t("about_tab_content.transport"), "Same-origin REST + SSE + Socket.IO terminal"],
];

export function AboutTabContent() {
  return (
    <div className="space-y-8">
      <div>
        <h3 className="font-semibold">Z Agent Native</h3>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {t("about_tab_content.samostoyatelnaya_ai_agent_platforma")}
        </p>
      </div>
      <SettingsSection title={t("about_tab_content.svedeniya_o_sisteme")}>
        <SettingsCard>
          {ABOUT_ROWS.map(([key, value]) => (
            <div key={key} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
              <span className="shrink-0 text-muted-foreground">{key}</span>
              <code className="break-all text-right text-xs">{value}</code>
            </div>
          ))}
        </SettingsCard>
      </SettingsSection>
      {/* Предупреждение о правах runtime — не рядовой абзац: теперь это
          карточка со значком, а не серый текст внизу страницы. */}
      <div className="flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-3">
        <span className="mt-0.5 shrink-0 text-warning">
          <WarningIcon size={15} />
        </span>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t("about_tab_content.agent_ispolnyaet_instrumenty_v_workspace")}
        </p>
      </div>
    </div>
  );
}
