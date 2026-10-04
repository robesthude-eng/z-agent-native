import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type ChatSkillSettings, type Skill } from "@/api/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { isTmpSession } from "@/lib/ids";
import { useStore } from "@/store/useStore";

const DEFAULT: ChatSkillSettings = {
  mode: "auto",
  selected: [],
  excluded: [],
  allowInstall: true,
};

export function ChatSkillsPicker({
  busy,
  open,
  onOpenChange,
}: {
  busy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const sessionId = useStore((s) => s.currentID);
  const [settings, setSettings] = useState<ChatSkillSettings>(DEFAULT);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [pending, setPending] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    setSettings(DEFAULT);
    setReady(false);
    setError("");
    setLoaded(false);
    if (!sessionId || isTmpSession(sessionId)) return;
    let disposed = false;
    void api
      .chatSkills(sessionId)
      .then((s) => {
        if (!disposed) {
          setSettings(s);
          setReady(true);
        }
      })
      .catch((err: unknown) => {
        if (!disposed) setError(String(err));
      });
    return () => {
      disposed = true;
    };
  }, [sessionId]);
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    void (async () => {
      if (!useStore.getState().currentID)
        await useStore.getState().newSession();
      await useStore.getState().materializeSession();
      return api.listSkillIndex();
    })()
      .then((list) => {
        if (!disposed) {
          setSkills(list);
          setLoaded(true);
        }
      })
      .catch((err: unknown) => {
        if (!disposed) setError(String(err));
      });
    return () => {
      disposed = true;
    };
  }, [open]);

  async function save(next: ChatSkillSettings) {
    if (!sessionId || isTmpSession(sessionId)) return;
    const previous = settings;
    setSettings(next);
    setPending(true);
    setError("");
    try {
      setSettings(await api.setChatSkills(sessionId, next));
    } catch (err) {
      setSettings(previous);
      setError(String(err));
    } finally {
      setPending(false);
    }
  }
  const locked = busy || pending || !ready;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="skills-chat-dialog w-[calc(100%-2rem)] max-w-lg rounded-2xl"
        aria-describedby="skills-chat-description"
      >
        <DialogHeader className="flex-row items-center justify-between">
          <DialogTitle>Скиллы этого чата</DialogTitle>
          <button
            type="button"
            aria-label="Закрыть выбор скиллов"
            className="h-11 w-11 flex items-center justify-center rounded-lg hover:bg-muted"
            onClick={() => onOpenChange(false)}
          >
            <X size={18} />
          </button>
        </DialogHeader>
        <DialogDescription id="skills-chat-description" className="px-5">
          Автовыбор подбирает скиллы по задаче. В ручном режиме используются
          только отмеченные.
        </DialogDescription>
        {error && (
          <p role="alert" className="break-words px-2 text-destructive">
            {error}
          </p>
        )}
        {open && (
          <section
            aria-label="Скиллы этого чата"
            className="space-y-4 px-5 pb-5 text-sm"
          >
            <label className="flex flex-wrap items-center gap-2">
              Режим этого чата
              <select
                aria-label="Режим скиллов"
                value={settings.mode}
                disabled={locked}
                onChange={(e) =>
                  void save({
                    ...settings,
                    mode: e.target.value as ChatSkillSettings["mode"],
                  })
                }
                className="rounded border border-border bg-background px-2 py-1"
              >
                <option value="auto">Агент выбирает сам</option>
                <option value="manual">Только выбранные</option>
                <option value="off">Не использовать скиллы</option>
              </select>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={settings.allowInstall}
                disabled={locked || settings.mode === "off"}
                onChange={(e) =>
                  void save({ ...settings, allowInstall: e.target.checked })
                }
              />
              Разрешить агенту устанавливать скиллы по вашему запросу
            </label>
            <p className="text-muted-foreground">
              Закреплённые навыки загружаются при каждом запросе. В автовыборе
              остальные подбираются по задаче. Библиотека и установка: Настройки
              → Память и навыки.
            </p>
            <div className="max-h-[38dvh] space-y-2 overflow-y-auto">
              {!loaded && <p>Загрузка…</p>}
              {loaded && !skills.length && (
                <p className="text-muted-foreground">
                  Пока нет установленных скиллов. Дайте агенту ссылку и
                  попросите изучить и установить подходящий.
                </p>
              )}
              {skills.map((skill) => (
                <div
                  key={skill.id}
                  className="rounded border border-border px-2 py-2"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="flex min-w-0 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={settings.selected.includes(skill.name)}
                        disabled={
                          locked || !skill.enabled || settings.mode === "off"
                        }
                        onChange={(e) =>
                          void save({
                            ...settings,
                            selected: e.target.checked
                              ? [...settings.selected, skill.name]
                              : settings.selected.filter(
                                  (n) => n !== skill.name,
                                ),
                            excluded: settings.excluded.filter(
                              (n) => n !== skill.name,
                            ),
                          })
                        }
                      />
                      <span>
                        {skill.name}
                        {!skill.enabled
                          ? " · выключен в библиотеке"
                          : !skill.autoUse
                            ? " · только вручную"
                            : ""}
                      </span>
                    </label>
                    {settings.mode === "auto" && (
                      <label className="flex items-center gap-1 text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={settings.excluded.includes(skill.name)}
                          disabled={locked || !skill.enabled}
                          onChange={(e) =>
                            void save({
                              ...settings,
                              selected: settings.selected.filter(
                                (n) => n !== skill.name,
                              ),
                              excluded: e.target.checked
                                ? [...settings.excluded, skill.name]
                                : settings.excluded.filter(
                                    (n) => n !== skill.name,
                                  ),
                            })
                          }
                        />
                        Исключить
                      </label>
                    )}
                  </div>
                  <p className="mt-1 text-muted-foreground">
                    {skill.description}
                  </p>
                </div>
              ))}
            </div>
            <p className="text-muted-foreground">
              До 8 закреплённых скиллов. Можно также написать $имя-скилла в
              сообщении.
            </p>
          </section>
        )}
        <div className="flex justify-end border-t border-border px-5 py-4">
          <button
            type="button"
            className="rounded-lg border border-border px-4 py-2 text-sm min-h-11 hover:bg-muted"
            onClick={() => onOpenChange(false)}
          >
            Готово
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
