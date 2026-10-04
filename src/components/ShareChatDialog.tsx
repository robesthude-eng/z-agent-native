import { useEffect, useState } from "react";
import { api, type ChatShare, shareUrl } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";

/** Публичная ссылка «только чтение» на текущий чат: создать, скопировать, отозвать. */
export function ShareChatDialog({
  sessionId,
  open,
  onClose,
}: {
  sessionId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [share, setShare] = useState<ChatShare | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !sessionId) return;
    let alive = true;
    setLoading(true);
    api
      .getChatShare(sessionId)
      .then((r) => alive && setShare(r.share))
      .catch(() => alive && setShare(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [open, sessionId]);

  const create = async () => {
    setLoading(true);
    try {
      const r = await api.createChatShare(sessionId);
      setShare(r.share);
      if (await copyText(shareUrl(r.share.token)))
        toast("success", "Ссылка создана и скопирована");
    } catch {
      toast("error", "Не удалось создать ссылку");
    } finally {
      setLoading(false);
    }
  };

  const revoke = async () => {
    setLoading(true);
    try {
      await api.deleteChatShare(sessionId);
      setShare(null);
      toast("success", "Ссылка отозвана");
    } catch {
      toast("error", "Не удалось отозвать ссылку");
    } finally {
      setLoading(false);
    }
  };

  const url = share ? shareUrl(share.token) : "";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[min(30rem,calc(100vw-2rem))]">
        <DialogHeader>
          <DialogTitle>Поделиться чатом</DialogTitle>
          <DialogDescription>
            По ссылке переписку можно читать без входа. Видны только сообщения и
            названия инструментов — вывод команд, файлы и рассуждения скрыты.
            Новые сообщения появляются по ссылке автоматически.
          </DialogDescription>
        </DialogHeader>
        {share ? (
          <div className="space-y-3">
            <div className="flex gap-2">
              <input
                readOnly
                value={url}
                onFocus={(e) => e.currentTarget.select()}
                className="h-9 min-w-0 flex-1 rounded-md border border-border bg-muted/40 px-3 text-sm"
                aria-label="Публичная ссылка"
              />
              <Button
                type="button"
                size="sm"
                className="h-9"
                onClick={async () => {
                  if (await copyText(url)) toast("success", "Скопировано");
                }}
              >
                Копировать
              </Button>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                Создана {new Date(share.created).toLocaleString()}
              </span>
              <div className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => window.open(url, "_blank", "noopener")}
                >
                  Открыть
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive hover:text-destructive"
                  disabled={loading}
                  onClick={() => void revoke()}
                >
                  Отозвать
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button
              type="button"
              disabled={loading}
              onClick={() => void create()}
            >
              {loading ? "…" : "Создать ссылку"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
