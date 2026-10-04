import { useCallback, useEffect, useState } from "react";
import { api, shareUrl } from "@/api/client";
import { useConfirm } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { chatToMarkdown, downloadText, safeFilename } from "@/lib/chatExport";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { DEFAULT_APP_SETTINGS } from "../../config/appSettings";
import { useStore } from "../../store/useStore";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives";

type Usage = Awaited<ReturnType<typeof api.storageUsage>>;
type Shares = Awaited<ReturnType<typeof api.listChatShares>>;

export function formatBytes(n: number) {
  if (!n) return "0 Б";
  const units = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
  const i = Math.min(
    Math.floor(Math.log(n) / Math.log(1024)),
    units.length - 1,
  );
  const v = n / 1024 ** i;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Раздел «Данные»: место на диске по чатам, экспорт и удаление. */
export function DataTabContent() {
  const removeSession = useStore((s) => s.removeSession);
  const setAppSettings = useStore((s) => s.setAppSettings);
  const askConfirm = useConfirm();
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [shares, setShares] = useState<Shares>([]);

  useEffect(() => {
    api
      .listChatShares()
      .then(setShares)
      .catch(() => setShares([]));
  }, []);

  const revokeShare = async (sessionId: string) => {
    try {
      await api.deleteChatShare(sessionId);
      setShares((list) => list.filter((x) => x.sessionId !== sessionId));
      toast("success", "Ссылка отозвана");
    } catch {
      toast("error", "Не удалось отозвать ссылку");
    }
  };

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    try {
      setUsage(await api.storageUsage(fresh));
    } catch {
      toast("error", "Не удалось посчитать место на диске");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const exportChat = async (id: string, title: string) => {
    setBusyId(id);
    try {
      const messages = await api.listMessages(id);
      downloadText(
        `${safeFilename(title)}.md`,
        chatToMarkdown(title, messages),
      );
    } catch {
      toast("error", "Не удалось выгрузить чат");
    } finally {
      setBusyId(null);
    }
  };

  const deleteChat = async (id: string, title: string, bytes: number) => {
    const ok = await askConfirm({
      title: `Удалить «${title}»?`,
      description: `Будут удалены история, файлы проекта (${formatBytes(bytes)}) и облачная машина чата. Это необратимо.`,
      confirmLabel: "Удалить",
      destructive: true,
    });
    if (!ok) return;
    setBusyId(id);
    try {
      await removeSession(id);
      setUsage((u) =>
        u
          ? {
              ...u,
              total: u.total - bytes,
              chats: u.chats.filter((c) => c.id !== id),
            }
          : u,
      );
    } finally {
      setBusyId(null);
    }
  };

  const resetSettings = async () => {
    const ok = await askConfirm({
      title: "Сбросить настройки?",
      description:
        "Шрифт, ширина чата, клавиша отправки, уведомления, стиль ответов и персональные инструкции вернутся к значениям по умолчанию. Чаты и ключи не затрагиваются.",
      confirmLabel: "Сбросить",
      destructive: true,
    });
    if (!ok) return;
    setAppSettings(DEFAULT_APP_SETTINGS);
    toast("success", "Настройки сброшены");
  };

  const max = usage?.chats[0]?.bytes || 1;

  return (
    <div className="space-y-8">
      <SettingsSection
        title={`Место на диске${usage ? ` · ${formatBytes(usage.total)}` : ""}`}
        description="Файлы проектов каждого чата на сервере. Удаление чата освобождает место и уменьшает бэкапы."
        actions={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={loading}
            onClick={() => void load(true)}
          >
            {loading ? "Считаю…" : "Обновить"}
          </Button>
        }
      >
        <SettingsCard>
          {usage?.chats.length ? (
            usage.chats.map((c) => (
              <div key={c.id} className="space-y-1.5 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {c.title}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatBytes(c.bytes)}
                      {c.updated
                        ? ` · ${new Date(c.updated).toLocaleDateString()}`
                        : ""}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busyId === c.id}
                      onClick={() => void exportChat(c.id, c.title)}
                    >
                      Экспорт
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      disabled={busyId === c.id}
                      onClick={() => void deleteChat(c.id, c.title, c.bytes)}
                    >
                      Удалить
                    </Button>
                  </div>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary/60"
                    style={{ width: `${Math.max(1, (c.bytes / max) * 100)}%` }}
                  />
                </div>
              </div>
            ))
          ) : (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {loading ? "Считаю место на диске…" : "Чатов пока нет"}
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Публичные ссылки"
        description="Чаты, открытые для чтения по ссылке. Создать ссылку — кнопка «Поделиться» над чатом."
      >
        <SettingsCard>
          {shares.length ? (
            shares.map((sh) => (
              <SettingsRow
                key={sh.token}
                label={sh.title}
                description={`Создана ${new Date(sh.created).toLocaleString()}`}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    if (await copyText(shareUrl(sh.token)))
                      toast("success", "Ссылка скопирована");
                  }}
                >
                  Копировать
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  onClick={() => void revokeShare(sh.sessionId)}
                >
                  Отозвать
                </Button>
              </SettingsRow>
            ))
          ) : (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              Открытых ссылок нет
            </div>
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Настройки">
        <SettingsCard>
          <SettingsRow
            label="Сбросить настройки"
            description="Внешний вид, чат, уведомления и инструкции агента — к значениям по умолчанию."
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void resetSettings()}
            >
              Сбросить
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
