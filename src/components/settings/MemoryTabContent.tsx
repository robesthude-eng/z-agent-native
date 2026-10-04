import { useCallback, useEffect, useState } from "react";
import {
  api,
  type MemoryEntry,
  type MemoryKind,
  type Skill,
} from "@/api/client";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { SettingsCard, SettingsSection, SettingsSegmented } from "./primitives";

const KIND_LABEL: Record<MemoryKind, string> = {
  fact: "Факт",
  preference: "Предпочтение",
  lesson: "Урок",
};

const KIND_OPTIONS: Array<{ id: MemoryKind; label: string }> = [
  { id: "preference", label: "Предпочтение" },
  { id: "fact", label: "Факт" },
  { id: "lesson", label: "Урок" },
];

function MemoryRow({
  entry,
  onDelete,
  onSave,
}: {
  entry: MemoryEntry;
  onDelete: () => void;
  onSave: (text: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry.text);
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        {editing ? (
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value.slice(0, 600))}
            rows={2}
            className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          />
        ) : (
          <div className="text-sm leading-relaxed">{entry.text}</div>
        )}
        <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span>{KIND_LABEL[entry.kind] ?? entry.kind}</span>
          <span>·</span>
          <span>
            {entry.scope === "global"
              ? "все чаты"
              : `чат «${entry.chatTitle || "удалён"}»`}
          </span>
          <span>·</span>
          <span>
            {entry.source === "user" ? "добавлено вами" : "запомнил агент"}
          </span>
          <span>·</span>
          <span>{new Date(entry.created).toLocaleDateString()}</span>
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        {editing ? (
          <Button
            type="button"
            size="sm"
            onClick={async () => {
              await onSave(text);
              setEditing(false);
            }}
          >
            Сохранить
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setEditing(true)}
          >
            Изменить
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          Удалить
        </Button>
      </div>
    </div>
  );
}

function SkillRow({
  skill,
  onDelete,
  onSave,
}: {
  skill: Skill;
  onDelete: () => void;
  onSave: (s: {
    name: string;
    description: string;
    content: string;
  }) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [description, setDescription] = useState(skill.description);
  const [content, setContent] = useState(skill.content);
  return (
    <div className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <button
          type="button"
          className="min-w-0 flex-1 text-left"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <div className="text-sm font-medium">{skill.name}</div>
          <div className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {skill.description} · использован {skill.uses}× · обновлён{" "}
            {new Date(skill.updated).toLocaleDateString()}
          </div>
        </button>
        <div className="flex shrink-0 gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setOpen(true);
              setEditing((v) => !v);
            }}
          >
            {editing ? "Отмена" : "Изменить"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            Удалить
          </Button>
        </div>
      </div>
      {open &&
        (editing ? (
          <div className="mt-2 space-y-2">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, 300))}
              className="h-8 w-full rounded-md border border-border bg-background px-2 text-sm"
              aria-label="Когда использовать"
            />
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={12}
              className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs"
              aria-label="Рецепт"
            />
            <div className="flex justify-end">
              <Button
                type="button"
                size="sm"
                onClick={async () => {
                  await onSave({ name: skill.name, description, content });
                  setEditing(false);
                }}
              >
                Сохранить
              </Button>
            </div>
          </div>
        ) : (
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-xs leading-relaxed">
            {skill.content}
          </pre>
        ))}
    </div>
  );
}

/** Раздел «Память и навыки»: что агент запомнил и какие рецепты сохранил. */
export function MemoryTabContent() {
  const askConfirm = useConfirm();
  const [memory, setMemory] = useState<MemoryEntry[] | null>(null);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [newText, setNewText] = useState("");
  const [newKind, setNewKind] = useState<MemoryKind>("preference");

  const load = useCallback(async () => {
    try {
      const [m, s] = await Promise.all([api.listMemory(), api.listSkills()]);
      setMemory(m);
      setSkills(s);
    } catch {
      toast("error", "Не удалось загрузить память агента");
      setMemory((m) => m ?? []);
      setSkills((s) => s ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const text = newText.trim();
    if (!text) return;
    try {
      const entry = await api.addMemory(text, newKind);
      setMemory((m) => [...(m ?? []).filter((x) => x.id !== entry.id), entry]);
      setNewText("");
      toast("success", "Запомнено");
    } catch {
      toast("error", "Не удалось сохранить");
    }
  };

  const removeEntry = async (entry: MemoryEntry) => {
    await api.deleteMemory(entry.id).catch(() => undefined);
    setMemory((m) => (m ?? []).filter((x) => x.id !== entry.id));
  };

  const removeSkill = async (skill: Skill) => {
    const ok = await askConfirm({
      title: `Удалить навык «${skill.name}»?`,
      description: "Агент больше не будет использовать этот рецепт.",
      confirmLabel: "Удалить",
      destructive: true,
    });
    if (!ok) return;
    await api.deleteSkill(skill.id).catch(() => undefined);
    setSkills((list) => (list ?? []).filter((x) => x.id !== skill.id));
  };

  const global = (memory ?? []).filter((m) => m.scope === "global");
  const perChat = (memory ?? []).filter((m) => m.scope !== "global");

  const memoryRows = (list: MemoryEntry[]) =>
    list
      .slice()
      .reverse()
      .map((entry) => (
        <MemoryRow
          key={entry.id}
          entry={entry}
          onDelete={() => void removeEntry(entry)}
          onSave={async (text) => {
            const updated = await api.updateMemory(entry.id, { text });
            setMemory((m) =>
              (m ?? []).map((x) =>
                x.id === entry.id ? { ...x, ...updated } : x,
              ),
            );
          }}
        />
      ));

  return (
    <div className="space-y-8">
      <SettingsSection
        title={`Память${memory ? ` · ${memory.length}` : ""}`}
        description="Факты, предпочтения и уроки, которые агент учитывает во всех чатах. Он пополняет их сам, когда вы его поправляете; можно добавить и вручную."
      >
        <SettingsCard>
          <div className="space-y-2 px-4 py-3">
            <textarea
              value={newText}
              onChange={(e) => setNewText(e.target.value.slice(0, 600))}
              placeholder="Например: «Сервер — Ubuntu 24.04, деплой только через ./run.sh»"
              rows={2}
              className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SettingsSegmented
                value={newKind}
                options={KIND_OPTIONS}
                onChange={setNewKind}
                ariaLabel="Тип записи"
              />
              <Button
                type="button"
                size="sm"
                disabled={!newText.trim()}
                onClick={() => void add()}
              >
                Запомнить
              </Button>
            </div>
          </div>
          {memory === null ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Загрузка…
            </div>
          ) : global.length ? (
            memoryRows(global)
          ) : (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Пока пусто
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      {perChat.length > 0 && (
        <SettingsSection
          title={`Память отдельных чатов · ${perChat.length}`}
          description="Действует только в своём чате и удаляется вместе с ним."
        >
          <SettingsCard>{memoryRows(perChat)}</SettingsCard>
        </SettingsSection>
      )}

      <SettingsSection
        title={`Навыки${skills ? ` · ${skills.length}` : ""}`}
        description="Рецепты, которые агент сохранил после успешных сложных задач, и использует снова, когда задача похожа."
      >
        <SettingsCard className={cn(!skills?.length && "divide-y-0")}>
          {skills === null ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Загрузка…
            </div>
          ) : skills.length ? (
            skills.map((skill) => (
              <SkillRow
                key={skill.id}
                skill={skill}
                onDelete={() => void removeSkill(skill)}
                onSave={async (next) => {
                  const saved = await api.saveSkill(next);
                  setSkills((list) =>
                    (list ?? []).map((x) => (x.id === skill.id ? saved : x)),
                  );
                  toast("success", "Навык сохранён");
                }}
              />
            ))
          ) : (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Навыков пока нет — агент начнёт сохранять их после успешных задач
            </div>
          )}
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
