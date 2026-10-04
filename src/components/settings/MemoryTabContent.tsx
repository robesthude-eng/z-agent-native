import { useCallback, useEffect, useState } from "react";
import { api, type MemoryEntry, type MemoryKind } from "@/api/client";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import { SkillsLibrary } from "../skills/SkillsLibrary";
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

/** Раздел «Память и навыки»: что агент запомнил и какие рецепты сохранил. */
export function MemoryTabContent() {
  const [memory, setMemory] = useState<MemoryEntry[] | null>(null);
  const [newText, setNewText] = useState("");
  const [newKind, setNewKind] = useState<MemoryKind>("preference");

  const load = useCallback(async () => {
    try {
      setMemory(await api.listMemory());
    } catch {
      toast("error", "Не удалось загрузить память агента");
      setMemory((m) => m ?? []);
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

      <SkillsLibrary />
    </div>
  );
}
