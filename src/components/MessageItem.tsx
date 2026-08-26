import { memo, useState } from "react";
import type { Message } from "../api/types";
import { messageText as getMessageText } from "../lib/chatText";
import { useStore } from "../store/useStore";
import { UserMessageBubble } from "./message/UserMessageBubble";
import { AssistantMessageBubble } from "./message/AssistantMessageBubble";
// TurnResultButton is rendered via MessageActions inside AssistantMessageBubble

interface MessageItemProps {
  messages: Message | Message[];
  isWorking?: boolean | undefined;
}

function MessageItemComponent({ messages, isWorking }: MessageItemProps) {
  const editAndResend = useStore((s) => s.editAndResend);
  const regenerate = useStore((s) => s.regenerate);
  const newSession = useStore((s) => s.newSession);
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

  const handleFork = (fromMessageId: string) => {
    if (!currentID) return;
    newSession();
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
                onFork={() => handleFork(message.id)}
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
      onSelectFile={() => {}}
      onRetry={() => {
        if (firstMsg?.id) regenerate(firstMsg.id);
      }}
      onFork={() => firstMsg && handleFork(firstMsg.id)}
    />
  );
}

const MessageItem = memo(MessageItemComponent);
export default MessageItem;
