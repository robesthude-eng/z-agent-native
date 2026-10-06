import { memo, useState } from "react";
import {
  isBarQuestionPart,
  isInterruptedQuestionPart,
  isInterruptionBarEnabled,
} from "../api/interruptions";
import type { ToolPart } from "../api/types";
import { rawToolStatus } from "../lib/toolStatus";
import MediaArtifact, { readMediaArtifact } from "./MediaArtifact";
import { QuestionCard, QuestionTrace } from "./tool-cards/QuestionCard";
import { ToolHeader } from "./tool-cards/ToolHeader";
import { ToolOutputView } from "./tool-cards/ToolOutputView";
import {
  getChangeStats,
  getMetadata,
  getOutput,
  getState,
  getSummary,
} from "./tool-cards/toolCardUtils";
import { Collapse } from "./ui/Collapse";

export { friendlyToolLabel } from "./tool-cards/toolCardUtils";

/** Инструменты, чей вывод идёт по мере работы: карточка открыта с самого начала. */
const LONG_RUNNING_TOOLS = new Set([
  "bash",
  "shell",
  "task",
  "git",
  "ssh_tool",
  "run_tests",
  "diagnostics",
]);

interface ToolCardProps {
  part: ToolPart;
}

function ToolCardComponent({ part }: ToolCardProps) {
  const toolName = (part.tool || "").toLowerCase();
  const state = getState(part);
  const metadata = getMetadata(part);
  const output = getOutput(part);
  const summary = getSummary(part);

  /*
    Раскрытие — производное от живого состояния, а не снимок на момент
    монтирования. Карточка почти всегда монтируется в состоянии pending:
    к моменту, когда вызов упал или пошёл вывод, useState уже зафиксировал
    false, и ошибку приходилось раскрывать руками. Явный клик сильнее
    автоматики — поэтому manuallyToggled побеждает (та же схема, что в
    ToolGroup).
  */
  const [manuallyToggled, setManuallyToggled] = useState<boolean | null>(null);
  // Работающая карточка раскрывается, когда есть что показать: вывод,
  // тело записываемого файла или заглушка «ждём вывод» у команд. У мгновенных
  // инструментов (read, grep …) пустая раскрытая карточка мигала бы: открылась
  // и тут же закрылась. Вызов в очереди (`pending`) раскрывается, только когда
  // дойдёт до выполнения.
  const queued = rawToolStatus(part) === "pending";
  const open =
    manuallyToggled ??
    ((state === "running" &&
      !queued &&
      (output.length > 0 || LONG_RUNNING_TOOLS.has(toolName))) ||
      state === "error");

  // 1. Question Tool Card or Interruption Trace
  if (toolName === "question") {
    if (isInterruptedQuestionPart(part) || !isBarQuestionPart(part)) {
      return <QuestionTrace part={part} />;
    }
    if (!isInterruptionBarEnabled()) {
      return <QuestionCard part={part} />;
    }
    return null;
  }

  // 2. Media Artifact rendering (Images / Audio / Videos / Documents)
  const mediaArtifact = readMediaArtifact(metadata);
  if (mediaArtifact) {
    return (
      <div className="my-2">
        <MediaArtifact media={mediaArtifact} />
      </div>
    );
  }

  // 3. Generic Tool Card (Bash, Read, Write, Edit, Patch, Grep, Glob, etc.)
  return (
    <div
      className={`group not-prose my-0.5 overflow-hidden rounded-lg border text-xs transition-[background-color,border-color] duration-200 ${open ? "border-border/70 bg-card/60" : "border-transparent"}`}
    >
      <ToolHeader
        toolName={toolName}
        summary={summary}
        state={state}
        open={open}
        onToggle={() => setManuallyToggled(!open)}
        output={output}
        stats={getChangeStats(part)}
      />
      <Collapse open={open}>
        <div className="border-t border-border/50 bg-background/40">
          <ToolOutputView part={part} />
        </div>
      </Collapse>
    </div>
  );
}

const ToolCard = memo(ToolCardComponent);
export default ToolCard;
