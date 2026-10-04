import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import {
  MAX_INSTRUCTIONS,
  type ResponseLanguage,
  type ResponseStyle,
} from "../../config/appSettings";
import { useStore } from "../../store/useStore";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsToggle,
} from "./primitives";

const STYLE_OPTIONS: Array<{ id: ResponseStyle; label: string }> = [
  { id: "concise", label: "Кратко" },
  { id: "default", label: "Обычно" },
  { id: "detailed", label: "Подробно" },
];

const LANGUAGE_OPTIONS: Array<{ id: ResponseLanguage; label: string }> = [
  { id: "auto", label: "Как в запросе" },
  { id: "ru", label: "Русский" },
  { id: "en", label: "English" },
];

const QUALITY_TOGGLES = [
  {
    key: "agentReview",
    label: "Ревьюер перед ответом",
    description:
      "Прежде чем сказать «готово», агент отдаёт изменённые файлы на независимую проверку и исправляет найденные ошибки. Дольше и чуть дороже, зато меньше «сделал, а не работает».",
  },
  {
    key: "agentVisualCheck",
    label: "Проверка интерфейса скриншотами",
    description:
      "После правок страниц и стилей агент смотрит на результат на компьютере и телефоне и правит вёрстку.",
  },
  {
    key: "agentMemory",
    label: "Память и навыки",
    description:
      "Агент запоминает ваши поправки, предпочтения и факты о среде, а успешные сложные процедуры сохраняет как навыки. Всё видно и редактируется в разделе «Память и навыки».",
  },
  {
    key: "agentDossier",
    label: "Досье для длинных чатов",
    description:
      "Когда история не помещается в контекст, старая часть пересказывается в досье (цель, решения, пути, состояние), а не выбрасывается.",
  },
  {
    key: "agentAutoResume",
    label: "Продолжать после фоновых задач",
    description:
      "Если долгая фоновая команда (сборка, обучение) закончилась после ответа агента, чат продолжится сам с её результатом.",
  },
] as const;

const EXAMPLES = [
  "Обращайся ко мне на «ты».",
  "Я пишу на TypeScript и Python, по умолчанию предлагай их.",
  "Перед большими изменениями коротко опиши план.",
  "Коммиты пиши на английском в стиле Conventional Commits.",
];

/** Раздел «Агент»: стиль ответов, язык и персональные инструкции. */
export function AgentTabContent() {
  const settings = useStore((s) => s.appSettings);
  const update = useStore((s) => s.setAppSettings);
  const [draft, setDraft] = useState(settings.customInstructions);

  // Настройки могли прийти с сервера позже открытия окна.
  useEffect(() => {
    setDraft(settings.customInstructions);
  }, [settings.customInstructions]);

  const dirty = draft !== settings.customInstructions;

  const save = () => {
    update({ customInstructions: draft.slice(0, MAX_INSTRUCTIONS) });
    toast(
      "success",
      "Инструкции сохранены — применятся со следующего сообщения",
    );
  };

  const addExample = (line: string) => {
    setDraft((d) => {
      const next = d.trim() ? `${d.trimEnd()}\n${line}` : line;
      return next.slice(0, MAX_INSTRUCTIONS);
    });
  };

  return (
    <div className="space-y-8">
      <SettingsSection
        title="Качество работы"
        description="Как агент проверяет себя и учится. Применяется со следующего сообщения."
      >
        <SettingsCard>
          {QUALITY_TOGGLES.map((item) => (
            <SettingsRow
              key={item.key}
              label={item.label}
              description={item.description}
            >
              <SettingsToggle
                checked={settings[item.key]}
                onChange={(v) => update({ [item.key]: v })}
                ariaLabel={item.label}
              />
            </SettingsRow>
          ))}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Стиль ответов"
        description="Применяется ко всем чатам со следующего сообщения."
      >
        <SettingsCard>
          <SettingsRow
            label="Подробность"
            description="Насколько развёрнуто агент объясняет результат."
          >
            <SettingsSegmented
              ariaLabel="Подробность ответов"
              value={settings.responseStyle}
              options={STYLE_OPTIONS}
              onChange={(responseStyle) => update({ responseStyle })}
            />
          </SettingsRow>
          <SettingsRow
            label="Язык ответов"
            description="«Как в запросе» — агент отвечает на языке вашего сообщения."
          >
            <SettingsSegmented
              ariaLabel="Язык ответов"
              value={settings.responseLanguage}
              options={LANGUAGE_OPTIONS}
              onChange={(responseLanguage) => update({ responseLanguage })}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Персональные инструкции"
        description="Что агенту стоит знать о вас и как работать. Добавляется к каждому запросу; правила безопасности системы остаются в приоритете."
      >
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <textarea
            value={draft}
            onChange={(e) =>
              setDraft(e.target.value.slice(0, MAX_INSTRUCTIONS))
            }
            rows={8}
            aria-label="Персональные инструкции"
            placeholder="Например: я Android-разработчик, отвечай кратко, код комментируй на русском…"
            className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-relaxed outline-none focus:ring-1 focus:ring-primary"
          />
          <div className="flex flex-wrap gap-1.5">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => addExample(ex)}
                className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-accent hover:text-foreground"
              >
                + {ex}
              </button>
            ))}
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              {draft.length} / {MAX_INSTRUCTIONS}
            </span>
            <div className="flex gap-2">
              {dirty && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setDraft(settings.customInstructions)}
                >
                  Отменить
                </Button>
              )}
              <Button type="button" size="sm" disabled={!dirty} onClick={save}>
                Сохранить
              </Button>
            </div>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
