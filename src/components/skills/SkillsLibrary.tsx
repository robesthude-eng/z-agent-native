import { SkillDetails } from "./SkillDetails";
import { useCallback, useEffect, useState } from "react";
import {
  api,
  type Skill,
  type SkillDiscovery,
  type SkillSourceInput,
} from "@/api/client";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  SettingsCard,
  SettingsSection,
} from "@/components/settings/primitives";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export function SkillsLibrary() {
  const confirm = useConfirm();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [source, setSource] = useState("");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<SkillDiscovery | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [replace, setReplace] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const refresh = useCallback(async () => {
    setSkills(await api.listSkillIndex());
    setLoaded(true);
  }, []);
  useEffect(() => {
    void refresh().catch((err) => setError(message(err)));
  }, [refresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  }
  const discover = (input: SkillSourceInput) =>
    run(async () => {
      setPreview(null);
      setPreview(await api.discoverSkills(input));
    });
  async function upload(file: File) {
    if (file.size > 16 * 1024 * 1024) {
      setError("Загружаемый файл не должен превышать 16 МБ");
      return;
    }
    await run(async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 8192)
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      setPreview(null);
      setPreview(
        await api.discoverSkills({
          filename: file.name,
          contentBase64: btoa(binary),
        }),
      );
    });
  }
  async function configure(
    skill: Skill,
    patch: { enabled?: boolean; autoUse?: boolean },
  ) {
    await run(async () => {
      const next = await api.configureSkill(skill.id, patch);
      setSkills((old) => old.map((s) => (s.id === next.id ? next : s)));
    });
  }

  return (
    <SettingsSection
      title={`Скиллы · ${skills.length}`}
      description="Общая библиотека для ваших чатов. Агент подбирает навыки по описанию; выбор для отдельного чата находится над полем сообщения."
    >
      <SettingsCard className="divide-y-0">
        <div className="space-y-3 p-4">
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (source.trim()) void discover({ source: source.trim() });
            }}
          >
            <input
              aria-label="Источник скиллов"
              placeholder="GitHub, ссылка на SKILL.md, ZIP или статью"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm"
            />
            <Button type="submit" size="sm" disabled={busy || !source.trim()}>
              {busy ? "Обработка…" : "Изучить"}
            </Button>
          </form>
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
            <span className="rounded-md border border-border px-3 py-1.5">
              Загрузить SKILL.md или ZIP
            </span>
            <input
              aria-label="Загрузить скилл"
              type="file"
              accept=".md,.zip"
              disabled={busy}
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void upload(file);
                e.target.value = "";
              }}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Установка не запускает скрипты и не выдаёт новых разрешений. Скиллы
            со специфическими командами Claude/Codex могут потребовать
            адаптации.
          </p>
          {error && (
            <p role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
          {preview && (
            <div className="space-y-2 rounded-lg border border-border p-3">
              <p className="break-all text-xs text-muted-foreground">
                Источник: {preview.origin.url}
                {preview.origin.revision
                  ? ` · версия ${preview.origin.revision.slice(0, 12)}`
                  : ""}
              </p>
              {preview.links.length > 0 && (
                <p className="text-sm">
                  В статье найдены источники. Выберите репозиторий, чтобы
                  изучить его скиллы:
                </p>
              )}
              {preview.links.map((link) => (
                <button
                  key={link}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setSource(link);
                    void discover({ source: link });
                  }}
                  className="block w-full break-all text-left text-sm text-primary underline"
                >
                  {link}
                </button>
              ))}
              {preview.candidates.length > 0 && (
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={replace}
                    onChange={(e) => setReplace(e.target.checked)}
                  />
                  Заменять уже установленную версию при совпадении имени
                </label>
              )}
              <div className="max-h-80 space-y-3 overflow-y-auto">
                {preview.candidates.map((candidate) => (
                  <div
                    key={candidate.path}
                    className="border-t border-border pt-2"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium">{candidate.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {candidate.description}
                        </p>
                        <p className="break-all text-xs text-muted-foreground">
                          {candidate.path || "SKILL.md"}
                        </p>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            const installed = await api.installSkill({
                              source: preview.source,
                              path: candidate.path,
                              replace,
                            });
                            await refresh();
                            toast("success", `Установлен ${installed.name}`);
                          })
                        }
                      >
                        Установить
                      </Button>
                    </div>
                    {candidate.warnings.length > 0 && (
                      <p className="mt-1 text-xs text-amber-600">
                        {candidate.warnings.join(" · ")}
                      </p>
                    )}
                  </div>
                ))}
              </div>
              {preview.invalid.map((item) => (
                <p key={item.path} className="text-xs text-destructive">
                  {item.path}: {item.error}
                </p>
              ))}
              {!preview.candidates.length &&
                !preview.links.length &&
                !preview.invalid.length && (
                  <p className="text-sm">Скиллы в этом источнике не найдены.</p>
                )}
            </div>
          )}
        </div>
      </SettingsCard>
      <div className="mt-3 space-y-2">
        <input
          aria-label="Поиск установленных скиллов"
          placeholder="Поиск в библиотеке"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        {!loaded && (
          <p className="text-sm text-muted-foreground">Загрузка библиотеки…</p>
        )}
        {loaded && !skills.length && (
          <p className="text-sm text-muted-foreground">
            Библиотека пуста. Установите скилл по ссылке, загрузите файл или
            попросите агента найти нужный навык.
          </p>
        )}
        {skills
          .filter((s) =>
            `${s.name} ${s.description}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
          .map((skill) => (
            <SettingsCard key={skill.id} className="divide-y-0">
              <div className="space-y-2 p-4">
                <SkillDetails skill={skill} onSaved={refresh} />
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{skill.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {skill.description}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        if (
                          !(await confirm({
                            title: `Удалить ${skill.name}?`,
                            description:
                              "Навык станет недоступен во всех ваших чатах.",
                            confirmLabel: "Удалить",
                            destructive: true,
                          }))
                        )
                          return;
                        await api.deleteSkill(skill.id);
                        await refresh();
                      })
                    }
                  >
                    Удалить
                  </Button>
                </div>
                <div className="flex flex-wrap gap-4 text-xs">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={skill.enabled}
                      disabled={busy}
                      onChange={(e) =>
                        void configure(skill, { enabled: e.target.checked })
                      }
                    />
                    Включён в библиотеке
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={skill.autoUse}
                      disabled={busy || !skill.enabled}
                      onChange={(e) =>
                        void configure(skill, { autoUse: e.target.checked })
                      }
                    />
                    Разрешить автовыбор
                  </label>
                </div>
                <p className="break-all text-xs text-muted-foreground">
                  {skill.source.url || "Создан агентом"}
                  {skill.source.revision
                    ? ` · ${skill.source.revision.slice(0, 12)}`
                    : ""}
                  {skill.source.fileCount
                    ? ` · ${skill.source.fileCount} файлов`
                    : ""}{" "}
                  · использован {skill.uses}×
                </p>
                {skill.warnings.length > 0 && (
                  <p className="text-xs text-amber-600">
                    {skill.warnings.join(" · ")}
                  </p>
                )}
                {skill.source.url?.startsWith("https://") && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      const url =
                        skill.source.type === "github" && skill.source.path
                          ? `${skill.source.url}/tree/${skill.source.ref || "HEAD"}/${skill.source.path}`
                          : skill.source.url;
                      if (url) {
                        setSource(url);
                        setReplace(true);
                        void discover({ source: url });
                      }
                    }}
                  >
                    Проверить источник / версию
                  </Button>
                )}
              </div>
            </SettingsCard>
          ))}
      </div>
    </SettingsSection>
  );
}
