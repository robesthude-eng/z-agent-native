import { memo, useState } from "react";
import {
  isBarQuestionPart,
  isInterruptedQuestionPart,
  isInterruptionBarEnabled,
} from "../api/interruptions";
import type { ToolPart } from "../api/types";
import MediaArtifact, { readMediaArtifact } from "./MediaArtifact";
import { QuestionCard, QuestionTrace } from "./tool-cards/QuestionCard";
import { ToolHeader } from "./tool-cards/ToolHeader";
import { ToolOutputView } from "./tool-cards/ToolOutputView";
import {
  getMetadata,
  getOutput,
  getState,
  getSummary,
} from "./tool-cards/toolCardUtils";

export { friendlyToolLabel } from "./tool-cards/toolCardUtils";

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
  const open = manuallyToggled ?? (state === "running" || state === "error");

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
    <div className="group not-prose my-1.5 overflow-hidden rounded-xl border border-border/70 bg-card/70 text-xs shadow-sm">
      <ToolHeader
        toolName={toolName}
        summary={summary}
        state={state}
        open={open}
        onToggle={() => setManuallyToggled(!open)}
        output={output}
      />
      {open && (
        <div className="border-t border-border/50 bg-background/40">
          <ToolOutputView part={part} />
        </div>
      )}
    </div>
  );
}

const ToolCard = memo(ToolCardComponent);
export default ToolCard;
