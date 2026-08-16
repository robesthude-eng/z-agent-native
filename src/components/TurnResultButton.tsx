import { GitBranch } from "lucide-react";
import { useState } from "react";
import TurnResultModal from "./TurnResultModal";

export default function TurnResultButton({
  sessionId,
  messageId,
  disabled = false,
}: {
  sessionId: string;
  messageId: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="inline-flex min-h-8 items-center gap-1 rounded-full px-2 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground disabled:opacity-40"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title="Показать изменения именно этого ответа"
      >
        <GitBranch className="h-3 w-3" />
        Результат
      </button>
      <TurnResultModal
        sessionId={sessionId}
        messageId={messageId}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
