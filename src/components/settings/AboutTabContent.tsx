import { SettingsCard, SettingsSection } from "./primitives";

const ABOUT_ROWS: Array<[string, string]> = [
  ["Версия", "Z Agent Native v1"],
  ["Runtime", "Собственный agent loop · sessions · tools · questions · permissions"],
  ["Модели", "OpenAI-compatible · Anthropic · Google Gemini · custom endpoints"],
  ["Workspace", "Изолированный каталог на чат · files · terminal · git · SSH через tools"],
  ["Хранилище", "SQLite z-agent.sqlite · owner-scoped sessions, keys, models, preferences"],
  ["Транспорт", "Same-origin REST + SSE + Socket.IO terminal"],
];

export function AboutTabContent() {
  return (
    <div className="space-y-8">
      <div>
        <h3 className="font-semibold">Z Agent Native</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Самостоятельная AI-agent платформа. UI общается непосредственно с собственным runtime; внешнего OpenCode server/runner/proxy нет.
        </p>
      </div>
      <SettingsSection title="Сведения о системе">
        <SettingsCard>
          {ABOUT_ROWS.map(([key, value]) => (
            <div key={key} className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
              <span className="shrink-0 text-muted-foreground">{key}</span>
              <code className="break-all text-right text-xs">{value}</code>
            </div>
          ))}
        </SettingsCard>
      </SettingsSection>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Агент исполняет инструменты в workspace текущего чата. Команды shell/SSH обладают реальными правами процесса runtime — в production запускайте сервис в изолированном контейнере с минимальными host-доступами.
      </p>
    </div>
  );
}
