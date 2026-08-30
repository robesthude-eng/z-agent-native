import { memo, useState } from "react";
import { t, tf } from "@/i18n";
import { toast } from "@/lib/toast";
import type { Message } from "../api/types";
import { messageText as getMessageText } from "../lib/chatText";
import { useStore } from "../store/useStore";
import { AssistantMessageBubble } from "./message/AssistantMessageBubble";
import { UserMessageBubble } from "./message/UserMessageBubble";
// TurnResultButton is rendered via MessageActions inside AssistantMessageBubble

interface MessageItemProps {
  messages: Message | Message[];
  isWorking?: boolean | undefined;
  /** Последняя группа ленты: только у неё «Повторить» безопасно. */
  isLatest?: boolean | undefined;
}

function MessageItemComponent({
  messages,
  isWorking,
  isLatest,
}: MessageItemProps) {
  const editAndResend = useStore((s) => s.editAndResend);
  const regenerate = useStore((s) => s.regenerate);
  const forkSession = useStore((s) => s.forkSession);
  const prefillComposer = useStore((s) => s.prefillComposer);
  const currentID = useStore((s) => s.currentID);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");

  const msgArray = Array.isArray(messages) ? messages : [messages];
  const firstMsg = msgArray[0];
  const role =
    firstMsg?.role ||
    (firstMsg?.info?.role as string | undefined) ||
    "assistant";
  const isUser = role === "user";

  /**
   * «Ответвление»: новый чат с историей разговора до этого сообщения.
   *
   * Раньше кнопка открывала пустой чат и перекладывала туда только текст
   * запроса: агент не видел ни решений, ни причин, и ответвление от
   * разговора оказывалось разговором с нуля. Теперь историю копирует
   * сервер, а сам запрос по-прежнему ложится в поле ввода — чтобы его
   * можно было переформулировать перед отправкой.
   *
   * Старый сервер без маршрута форка даёт прежнее поведение, но теперь
   * об этом говорят вслух: молчаливая потеря контекста хуже предупреждения.
   */
  const handleFork = (message: Message) => {
    const text = getMessageText(message).trim();
    forkSession(message.id)
      .then((outcome) => {
        if (text) prefillComposer(text);
        toast(
          outcome.ok ? "success" : "info",
          outcome.ok
            ? tf("message_item.otvetvlenie_sozdano_0", [outcome.copied])
            : t("message_item.otvetvlenie_bez_istorii"),
        );
      })
      .catch(() => {});
  };

  if (isUser) {
    return (
      <div className="group oc-msg-in flex flex-col items-end gap-1 px-3 py-1 md:px-6">
        <div className="flex min-w-0 flex-col gap-1 items-end max-w-full">
          {msgArray.map((message, idx) => {
            const isEditing = editingId === message.id;
            return (
              <UserMessageBubble
                key={message.id || idx}
                message={message}
                isEditing={isEditing}
                editText={editText}
                onEditTextChange={setEditText}
                onStartEditing={() => {
                  setEditingId(message.id);
                  setEditText(getMessageText(message));
                }}
                onCancelEditing={() => {
                  setEditingId(null);
                  setEditText("");
                }}
                onSaveAndResend={() => {
                  if (currentID && editText.trim()) {
                    editAndResend(message.id, editText.trim()).catch(() => {});
                    setEditingId(null);
                  }
                }}
                onFork={() => handleFork(message)}
                isLatest={idx === msgArray.length - 1}
              />
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <AssistantMessageBubble
      messages={msgArray}
      isWorking={isWorking}
      isLatestTurn={isLatest}
      onRetry={() => {
        if (firstMsg?.id) regenerate(firstMsg.id);
      }}
    />
  );
}

const MessageItem = memo(MessageItemComponent);
export default MessageItem;
