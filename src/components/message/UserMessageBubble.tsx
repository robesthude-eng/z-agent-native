import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import type { Message } from "../../api/types";
import { extractAttachments } from "../../lib/attachments";
import { messageText as getMessageText } from "../../lib/chatText";
import { AttachmentChip } from "../AttachmentChip";
import { partKey } from "../messageFlow";
import PartView from "../PartView";
import UserMessageText from "../UserMessageText";
import { MessageActions } from "./MessageActions";

interface UserMessageBubbleProps {
  message: Message;
  isEditing: boolean;
  editText: string;
  onEditTextChange: (val: string) => void;
  onStartEditing: () => void;
  onCancelEditing: () => void;
  onSaveAndResend: () => void;
  onFork: () => void;
  isLatest: boolean;
}

export function UserMessageBubble({
  message,
  isEditing,
  editText,
  onEditTextChange,
  onStartEditing,
  onCancelEditing,
  onSaveAndResend,
  onFork,
  isLatest,
}: UserMessageBubbleProps) {
  /*
    Фокус в поле правки ставится один раз за сеанс редактирования.
    Прежний `ref={(el) => el?.focus()}` вызывался на каждом рендере и уводил
    курсор в конец текста, пока человек правил середину сообщения.
  */
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!isEditing) focusedRef.current = false;
  }, [isEditing]);

  const msgText = getMessageText(message);
  const { refs, rest } = extractAttachments(msgText);
  const realAttParts = (message.parts || []).filter(
    (p) => p.type === "attachment" || p.type === "file",
  );
  const attPartNames = new Set(
    realAttParts
      .map((p) => {
        const f = p as { name?: unknown; filename?: unknown };
        const n = typeof f.name === "string" ? f.name : f.filename;
        return typeof n === "string" ? n : "";
      })
      .filter(Boolean),
  );
  const uniqueRefs = refs.filter((r) => !attPartNames.has(r.name));

  return (
    <div className="flex w-full flex-col gap-1 max-w-[min(100%,700px)] self-end items-end">
      {(uniqueRefs.length > 0 || realAttParts.length > 0) && (
        <div className="flex flex-wrap gap-2 justify-end">
          {uniqueRefs.map((r) => (
            <AttachmentChip key={r.path || r.name} file={r} />
          ))}
          {realAttParts.map((part) => (
            <PartView key={partKey(part)} part={part} />
          ))}
        </div>
      )}

      {isEditing ? (
        <div className="flex w-full flex-col gap-2 rounded-2xl border border-border bg-card p-3 shadow-sm">
          <textarea
            ref={(el) => {
              if (!el || focusedRef.current) return;
              focusedRef.current = true;
              el.focus();
              const end = el.value.length;
              el.setSelectionRange(end, end);
            }}
            value={editText}
            onChange={(e) => onEditTextChange(e.target.value)}
            onKeyDown={(e) => {
              /*
                Шпаргалка обещала ⌘/Ctrl+Enter для повторной отправки, а Esc
                здесь ожидается сам собой — но обработчика не было, и правку
                можно было завершить только мышью.
              */
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                if (editText.trim()) onSaveAndResend();
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                onCancelEditing();
              }
            }}
            className="w-full resize-y rounded-lg border border-border bg-background p-2 text-sm text-foreground outline-none focus:border-ring"
            rows={Math.min(10, Math.max(2, editText.split("\n").length))}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onCancelEditing}
              className="text-xs"
            >
              {t("confirm_dialog.otmena")}
            </Button>
            <Button
              size="sm"
              onClick={onSaveAndResend}
              disabled={!editText.trim()}
              className="text-xs"
            >
              {t("composer.otpravit")}
            </Button>
          </div>
        </div>
      ) : (
        <div className="group/bubble relative flex flex-col items-end">
          <div className="rounded-2xl bg-secondary px-4 py-2.5 text-secondary-foreground text-sm leading-relaxed shadow-sm max-w-full">
            <UserMessageText text={rest || "…"} />
          </div>
          <div className="mt-1 flex items-center justify-end">
            <MessageActions
              role="user"
              visibleText={rest}
              isLatestTurn={false}
              isStreaming={false}
              onRetry={() => {}}
              onEditAndResend={onStartEditing}
              onFork={onFork}
              showEditButton={true}
            />
          </div>
        </div>
      )}
    </div>
  );
}
