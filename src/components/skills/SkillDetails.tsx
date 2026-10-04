import { useState } from "react";
import { api, type Skill } from "@/api/client";
import { Button } from "@/components/ui/button";

export function SkillDetails({
  skill,
  onSaved,
}: {
  skill: Skill;
  onSaved: () => Promise<void>;
}) {
  const [content, setContent] = useState<string | null>(null);
  const [description, setDescription] = useState(skill.description);
  const [editing, setEditing] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  return (
    <details
      onToggle={(event) => {
        if (!event.currentTarget.open || content !== null || pending) return;
        setPending(true);
        void api
          .getSkill(skill.id)
          .then((loaded) => {
            setContent(loaded.content || "");
            setDescription(loaded.description);
          })
          .catch((err: unknown) => setError(String(err)))
          .finally(() => setPending(false));
      }}
    >
      <summary className="cursor-pointer text-xs text-muted-foreground">
        Инструкции / изменить
      </summary>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {pending && <p className="text-xs">Загрузка…</p>}
      {content !== null &&
        (editing ? (
          <div className="mt-2 space-y-2">
            <input
              aria-label={`Описание ${skill.name}`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={1024}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
            />
            <textarea
              aria-label={`Инструкции ${skill.name}`}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              maxLength={96000}
              rows={10}
              className="w-full rounded-md border border-border bg-background p-2 font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Изменения сохраняются в библиотеке. Файлы пакета остаются
              прежними; установка с заменой вернёт инструкции из источника.
            </p>
            <Button
              type="button"
              size="sm"
              disabled={pending}
              onClick={() => {
                setPending(true);
                setError("");
                void api
                  .saveSkill({ name: skill.name, description, content })
                  .then(async () => {
                    await onSaved();
                    setEditing(false);
                  })
                  .catch((err: unknown) => setError(String(err)))
                  .finally(() => setPending(false));
              }}
            >
              Сохранить
            </Button>
          </div>
        ) : (
          <div className="mt-2 space-y-2">
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">
              {content}
            </pre>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setEditing(true)}
            >
              Изменить инструкции
            </Button>
          </div>
        ))}
    </details>
  );
}
