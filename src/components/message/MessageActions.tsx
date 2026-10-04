import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import CopyButton from "../CopyButton";
import { PencilIcon, RefreshIcon } from "../icons";

export interface MessageActionsProps {
  messageRole: string;
  visibleText: string;
  sessionId?: string | undefined;
  messageId?: string | undefined;
  isLatestTurn: boolean;
  isStreaming: boolean;
  onRetry: () => void;
  /** Нет у ответа агента: редактируются только свои сообщения. */
  onEditAndResend?: (() => void) | undefined;
  showEditButton: boolean;
}

export function MessageActions({
  messageRole,
  visibleText,
  isLatestTurn,
  isStreaming,
  onRetry,
  onEditAndResend,
  showEditButton,
}: MessageActionsProps) {
  return (
    // На таче hover не существует, а вместе с ним не существовало «Повторить»,
    // копирования и итога хода: кнопки были нарисованы, но прозрачны. Поэтому
    // прячем их только там, где есть мышь, и показываем при фокусе с клавиатуры.
    <div className="chat-message-actions flex items-center gap-0 transition-opacity opacity-100 group-focus-within:opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
      {visibleText && (
        <CopyButton text={visibleText} className="chat-message-action" />
      )}

      {messageRole === "assistant" && isLatestTurn && !isStreaming && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onRetry}
          className="chat-message-action text-muted-foreground hover:text-foreground"
          title={t("message_item.peregenerirovat_otvet")}
          aria-label={t("message_item.peregenerirovat_otvet")}
        >
          <RefreshIcon size={16} />
        </Button>
      )}

      {messageRole === "user" && showEditButton && onEditAndResend && (
        <Button
          variant="ghost"
          size="icon"
          onClick={onEditAndResend}
          className="chat-message-action text-muted-foreground hover:text-foreground"
          title={t("message_item.izmenit_soobschenie")}
          aria-label={t("message_item.izmenit_soobschenie")}
        >
          <PencilIcon size={16} />
        </Button>
      )}
    </div>
  );
}
