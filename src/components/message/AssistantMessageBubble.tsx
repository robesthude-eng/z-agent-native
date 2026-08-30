import { useState } from "react";
import { t } from "@/i18n";
import { toolPhase } from "@/lib/toolStatus";
import { errorMessage, isAbortedError } from "../../api/eventGuards";
import { isInterruptedQuestionPart } from "../../api/interruptions";
import type { Message, Part } from "../../api/types";
import { visibleMessageText as getVisibleText } from "../../lib/chatText";
import AgentActivity from "../AgentActivity";
import {
  type ActivityRun,
  flowParts,
  groupActivityRuns,
  groupParts,
  itemKey,
  partKey,
  type RenderItem,
  runStepCount,
  runToolParts,
  type ToolGroupData,
} from "../messageFlow";
import PartView from "../PartView";
import ToolGroup from "../ToolGroup";
import { GeneratedFiles } from "./GeneratedFiles";
import { MessageActions } from "./MessageActions";
import { TurnSummaryCard } from "./TurnSummaryCard";
import { assistantTurnSummary, strategyChanged } from "./turnSummary";

interface AssistantMessageBubbleProps {
  messages: Message[];
  isWorking?: boolean | undefined;
  /**
   * Последняя группа ленты.
   *
   * «Повторить» было у каждого ответа в истории (`isLatestTurn={true}`
   * жёстко), а перегенерация старого ответа перезапускает последний ход
   * и теряет всё, что было после него.
   */
  isLatestTurn?: boolean | undefined;
  onRetry: () => void;
}

export function AssistantMessageBubble({
  messages,
  isWorking,
  isLatestTurn,
  onRetry,
}: AssistantMessageBubbleProps) {
  const [errorDetailsId, setErrorDetailsId] = useState<string | null>(null);

  const firstMsg = messages[0];
  const combinedText = messages
    .map((m) => getVisibleText(m))
    .filter(Boolean)
    .join("\n\n");

  const turnMeta = !isWorking ? assistantTurnSummary(messages) : null;
  const hasWorkspaceResultHint =
    !isWorking &&
    Boolean(firstMsg?.id && firstMsg?.sessionID) &&
    ((turnMeta?.changedFiles.length ?? 0) > 0 ||
      messages.some(strategyChanged));

  const items = groupParts(flowParts(messages));
  const attParts = items.filter(
    (item) =>
      "type" in item && (item.type === "attachment" || item.type === "file"),
  );
  const otherParts = items.filter(
    (item) =>
      !("type" in item) || (item.type !== "attachment" && item.type !== "file"),
  );
  const flow = groupActivityRuns(otherParts);

  const renderFlowPart = (item: RenderItem, streaming: boolean) => {
    const g = item as ToolGroupData;
    if ("kind" in g && g.kind === "group") {
      return <ToolGroup key={itemKey(item)} tool={g.tool} parts={g.parts} />;
    }
    return (
      <PartView
        key={itemKey(item)}
        part={item as Part}
        {...(streaming ? { isLastStreaming: true } : {})}
      />
    );
  };

  return (
    <div className="group oc-msg-in flex flex-col items-start gap-1 px-3 py-1 md:px-6">
      <div className="flex w-full flex-col gap-1 max-w-[min(100%,700px)]">
        {attParts.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {attParts.map((item) => (
              <PartView key={partKey(item as Part)} part={item as Part} />
            ))}
          </div>
        )}

        <div className="flex flex-col gap-2">
          {flow.map((fi, i) => {
            const isTail = !!isWorking && i === flow.length - 1;
            if ((fi as ActivityRun).kind === "activity") {
              const run = fi as ActivityRun;
              const first = run.items[0];
              // Один шаг — не цепочка действий. Шапка «Готово · 1 шаг» ничего
              // не сообщала сверх самого шага, но добавляла уровень раскрытия.
              if (run.items.length === 1 && first) {
                return renderFlowPart(first, isTail);
              }
              const tools = runToolParts(run.items);
              const anyRunning = tools.some(
                (toolPart) => toolPhase(toolPart) === "running",
              );
              const hasError = tools.some(
                (toolPart) =>
                  toolPhase(toolPart) === "error" &&
                  !isInterruptedQuestionPart(toolPart),
              );
              return (
                <AgentActivity
                  key={`act:${first ? itemKey(first) : i}`}
                  count={runStepCount(run.items)}
                  running={anyRunning}
                  hasError={hasError}
                >
                  {run.items.map((it, j) =>
                    renderFlowPart(it, isTail && j === run.items.length - 1),
                  )}
                </AgentActivity>
              );
            }
            return renderFlowPart(fi as RenderItem, isTail);
          })}
        </div>

        {messages.map((m) => {
          const err = m.info?.error;
          if (!err || isAbortedError(err)) return null;
          const isExpanded = errorDetailsId === m.id;
          return (
            <div
              key={`err-${m.id}`}
              className="mt-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
            >
              <div className="flex items-center justify-between">
                <span className="font-medium">
                  {errorMessage(err) || t("changes_panel.oshibka")}
                </span>
                {typeof err === "object" && (
                  <button
                    type="button"
                    onClick={() => setErrorDetailsId(isExpanded ? null : m.id)}
                    aria-expanded={isExpanded}
                    className="text-[11px] underline opacity-80 hover:opacity-100"
                  >
                    {isExpanded
                      ? t("message_item.skryt_detali")
                      : t("message_item.detali")}
                  </button>
                )}
              </div>
              {isExpanded && typeof err === "object" && (
                <pre className="mt-2 max-h-40 overflow-auto rounded bg-background/50 p-2 text-[10px] text-foreground">
                  {JSON.stringify(err, null, 2)}
                </pre>
              )}
            </div>
          );
        })}

        {messages.map((m) => (
          <GeneratedFiles key={`files-${m.id}`} message={m} />
        ))}

        {!isWorking && turnMeta && hasWorkspaceResultHint && (
          <TurnSummaryCard
            summary={turnMeta}
            strategyMutated={messages.some(strategyChanged)}
          />
        )}

        <div className="mt-1 flex items-center justify-between gap-2">
          <MessageActions
            role="assistant"
            visibleText={combinedText}
            sessionId={firstMsg?.sessionID}
            messageId={firstMsg?.id}
            isLatestTurn={Boolean(isLatestTurn)}
            isStreaming={Boolean(isWorking)}
            onRetry={onRetry}
            showEditButton={false}
          />
        </div>
      </div>
    </div>
  );
}
