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
  /** Нет у ответа агента: редактируются только свои сообщения. */
  onEditAndResend?: (() => void) | undefined;
  /** Нет у ответа агента: ответвляют от своего запроса. */
  onFork?: (() => void) | undefined;
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
    // На таче hover не существует, а вместе с ним не существовало «Повторить»,
    // копирования и итога хода: кнопки были нарисованы, но прозрачны. Поэтому
    // прячем их только там, где есть мышь, и показываем при фокусе с клавиатуры.
    <div className="flex items-center gap-1 transition-opacity opacity-100 group-focus-within:opacity-100 md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100">
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
          <span className="ml-1">{t("message_item.povtorit")}</span>
        </Button>
      )}

      {role === "user" && showEditButton && onEditAndResend && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onEditAndResend}
          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          title={t("message_item.izmenit_soobschenie")}
        >
          {t("message_item.izmenit")}
        </Button>
      )}

      {role === "user" && onFork && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onFork}
          className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
          title={t("message_item.otvetvit_ot_etogo_soobscheniya")}
        >
          <NewChatIcon size={13} />
          <span className="ml-1">{t("message_item.otvetvlenie")}</span>
        </Button>
      )}
    </div>
  );
}
