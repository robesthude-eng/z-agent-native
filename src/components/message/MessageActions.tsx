import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import CopyButton from "../CopyButton";
import { NewChatIcon, RefreshIcon } from "../icons";
import TurnResultButton from "../TurnResultButton";

export interface MessageActionsProps {
  role: string;
  visibleText: string;
  sessionId?: string | undefined;
  messageId?: string | undefined;
  isLatestTurn: boolean;
  isStreaming: boolean;
  onRetry: () => void;
  onEditAndResend: () => void;
  onFork: () => void;
  showEditButton: boolean;
}

export function MessageActions({
  role,
  visibleText,
  sessionId,
  messageId,
  isLatestTurn,
  isStreaming,
  onRetry,
  onEditAndResend,
  onFork,
  showEditButton,
}: MessageActionsProps) {
  return (
    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
      {visibleText && <CopyButton text={visibleText} />}

      {role === "assistant" && sessionId && messageId && (
        <TurnResultButton sessionId={sessionId} messageId={messageId} />
      )}

      {role === "assistant" && isLatestTurn && !isStreaming && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onRetry}
          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          title={t("message_item.peregenerirovat_otvet")}
        >
          <RefreshIcon size={13} />
          <span className="ml-1">Повторить</span>
        </Button>
      )}

      {role === "user" && showEditButton && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onEditAndResend}
          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
        >
          Изменить
        </Button>
      )}

      {role === "user" && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onFork}
          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          title={t("shortcuts_overlay.novyy_chat")}
        >
          <NewChatIcon size={13} />
          <span className="ml-1">Ответвление</span>
        </Button>
      )}
    </div>
  );
}
