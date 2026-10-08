import { useCallback, useEffect, useState } from "react";
import {
  api,
  type InstinctEntry,
  type MemoryEntry,
  type MemoryKind,
} from "@/api/client";
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

function InstinctRow({
  entry,
  onChange,
  onDelete,
}: {
  entry: InstinctEntry;
  onChange: (patch: {
    status?: "active" | "dismissed";
    scope?: "global";
  }) => void;
  onDelete: () => void;
}) {
  const dismissed = entry.status === "dismissed";
  const level =
    entry.confidence >= 0.7
      ? "уверенно"
      : entry.confidence >= 0.5
        ? "умеренно"
        : "пробно";
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <div className={`min-w-0 flex-1 ${dismissed ? "opacity-50" : ""}`}>
        <div className="text-sm leading-relaxed">
          <span className="text-muted-foreground">{entry.trigger} →</span>{" "}
          {entry.action}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          <span>
            {level} · {Math.round(entry.confidence * 100)}%
          </span>
          <span>·</span>
          <span>{entry.domain}</span>
          <span>·</span>
          <span>
            {entry.scope === "global"
              ? "все чаты"
              : `чат «${entry.chatTitle || "удалён"}»`}
          </span>
          <span>·</span>
          <span>подтверждений: {entry.observations}</span>
          {dismissed && (
            <>
              <span>·</span>
              <span>отключено</span>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 gap-1">
        {entry.scope !== "global" && !dismissed && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange({ scope: "global" })}
          >
            Для всех чатов
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange({ status: dismissed ? "active" : "dismissed" })
          }
        >
          {dismissed ? "Включить" : "Отключить"}
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
  );
}

/** Раздел «Память и навыки»: что агент запомнил и какие рецепты сохранил. */
export function MemoryTabContent() {
  const [memory, setMemory] = useState<MemoryEntry[] | null>(null);
  const [newText, setNewText] = useState("");
  const [newKind, setNewKind] = useState<MemoryKind>("preference");
  const [instincts, setInstincts] = useState<InstinctEntry[] | null>(null);

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

  useEffect(() => {
    api
      .listInstincts()
      .then(setInstincts)
      .catch(() => setInstincts([]));
  }, []);

  const changeInstinct = async (
    entry: InstinctEntry,
    patch: { status?: "active" | "dismissed"; scope?: "global" },
  ) => {
    try {
      const updated = await api.updateInstinct(entry.id, patch);
      setInstincts((list) =>
        (list ?? []).map((x) =>
          x.id === entry.id
            ? { ...x, ...updated, chatTitle: x.chatTitle ?? null }
            : x,
        ),
      );
    } catch (e) {
      toast("error", e instanceof Error ? e.message : "Не удалось изменить");
    }
  };

  const exportInstincts = async () => {
    try {
      const data = await api.exportInstincts();
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "instincts.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast("error", "Не удалось экспортировать");
    }
  };

  const importInstincts = async (file: File | undefined) => {
    if (!file) return;
    try {
      const result = await api.importInstincts(JSON.parse(await file.text()));
      toast(
        "success",
        `Импортировано: ${result.imported}, пропущено: ${result.skipped}`,
      );
      setInstincts(await api.listInstincts());
    } catch {
      toast("error", "Файл не похож на экспорт инстинктов");
    }
  };

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

      <SettingsSection
        title={`Выученные привычки${instincts ? ` · ${instincts.filter((i) => i.status === "active").length}` : ""}`}
        description="Короткие правила «когда → делай», которые агент вывел из ваших поправок и исправленных ошибок. Пробные (до 50%) в запросы не попадают; в запрос уходят до шести самых уверенных. Экспортируются только сами правила — без переписки."
      >
        <SettingsCard>
          {instincts === null ? (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Загрузка…
            </div>
          ) : instincts.length ? (
            instincts.map((entry) => (
              <InstinctRow
                key={entry.id}
                entry={entry}
                onChange={(patch) => void changeInstinct(entry, patch)}
                onDelete={() => {
                  void api.deleteInstinct(entry.id).catch(() => undefined);
                  setInstincts((list) =>
                    (list ?? []).filter((x) => x.id !== entry.id),
                  );
                }}
              />
            ))
          ) : (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Пока ничего не выучено
            </div>
          )}
          <div className="flex flex-wrap justify-end gap-2 px-4 py-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void exportInstincts()}
            >
              Экспорт
            </Button>
            <label className="inline-flex cursor-pointer items-center rounded-md px-3 text-sm hover:bg-muted">
              Импорт
              <input
                type="file"
                accept="application/json"
                className="sr-only"
                onChange={(e) => {
                  void importInstincts(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SkillsLibrary />
    </div>
  );
}
