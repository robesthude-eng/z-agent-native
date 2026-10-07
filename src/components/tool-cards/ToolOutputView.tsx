import { useLayoutEffect, useRef } from "react";
import { t } from "@/i18n";
import type { ToolPart } from "../../api/types";
import {
  extractToolEdits,
  extractToolFilePath,
  extractWrittenContent,
} from "../../lib/toolEdits";
import DiffView from "../DiffView";
import { getInput, getOutput, getState } from "./toolCardUtils";

interface ToolOutputViewProps {
  part: ToolPart;
}

/**
 * Окно вывода инструмента. Пока инструмент работает, оно следует за концом
 * вывода (как терминал), чтобы новые строки были видны сразу; если
 * пользователь прокрутил вверх, чтение не сбивается.
 */
function LivePre({
  text,
  live,
  className,
}: {
  text: string;
  live: boolean;
  className: string;
}) {
  const ref = useRef<HTMLPreElement | null>(null);
  const stick = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: прокрутка нужна при каждом изменении текста
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && live && stick.current) el.scrollTop = el.scrollHeight;
  }, [text, live]);
  return (
    <pre
      ref={ref}
      className={className}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
    >
      {text}
    </pre>
  );
}

export function ToolOutputView({ part }: ToolOutputViewProps) {
  const tool = (part.tool || "").toLowerCase();
  const state = getState(part);
  const rawOutput = getOutput(part);
  const input = getInput(part) as Record<string, unknown> | undefined;

  const isStreaming = state === "running";
  // Вывод показывается сразу, как пришёл: без сглаживания и задержки.
  const output = rawOutput;

  // Разбираем аргументы вызова, а не саму часть: раньше сюда передавалась
  // вся part, полей правки в ней нет, и карточка показывала только
  // «Edited file» вместо разницы.
  const filePath = extractToolFilePath(input);
  const edits = extractToolEdits(input);
  const writtenContent = extractWrittenContent(input);

  if (tool === "edit" && edits && edits.length > 0) {
    return (
      <div className="p-2 overflow-x-auto text-xs">
        {filePath && (
          <div className="text-[11px] font-mono text-muted-foreground mb-1">
            {filePath}
          </div>
        )}
        {edits.map((e, idx) => (
          <DiffView
            // biome-ignore lint/suspicious/noArrayIndexKey: edits are a static list from the tool call and have no stable id
            key={idx}
            oldText={e.oldText}
            newText={e.newText}
          />
        ))}
      </div>
    );
  }

  if (tool === "write" && writtenContent != null) {
    return (
      <div className="p-2 overflow-x-auto text-xs">
        {filePath && (
          <div className="text-[11px] font-mono text-muted-foreground mb-1">
            {filePath}
          </div>
        )}
        <LivePre
          text={writtenContent}
          live={isStreaming}
          className="p-2 rounded bg-background/50 font-mono text-[11px] overflow-auto max-h-72"
        />
      </div>
    );
  }

  return (
    <div className="p-2.5 overflow-x-auto text-xs font-mono">
      {input && tool === "bash" && typeof input.command === "string" && (
        <div className="mb-2 text-foreground/90 pb-1 border-b border-border/40">
          <span className="text-muted-foreground mr-1.5">$</span>
          {input.command}
        </div>
      )}

      {output ? (
        <LivePre
          text={output}
          live={isStreaming}
          className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground/90 max-h-80 overflow-y-auto"
        />
      ) : (
        <span className="text-[11px] text-muted-foreground italic">
          {isStreaming
            ? t("tool_output_view.waiting_output")
            : t("tool_output_view.net_vyvoda")}
        </span>
      )}
    </div>
  );
}
