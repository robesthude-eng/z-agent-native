import type { ToolPart } from "../../api/types";
import {
  extractToolEdits,
  extractToolFilePath,
  extractWrittenContent,
} from "../../lib/toolEdits";
import { useSmoothStreamingText } from "../../lib/useSmoothText";
import DiffView from "../DiffView";
import { getInput, getOutput, getState } from "./toolCardUtils";

interface ToolOutputViewProps {
  part: ToolPart;
}

export function ToolOutputView({ part }: ToolOutputViewProps) {
  const tool = (part.tool || "").toLowerCase();
  const state = getState(part);
  const rawOutput = getOutput(part);
  const input = getInput(part) as Record<string, unknown> | undefined;

  const isStreaming = state === "running";
  const smoothedOutput = useSmoothStreamingText(rawOutput, isStreaming);
  const output = isStreaming ? smoothedOutput : rawOutput;

  const filePath = extractToolFilePath(part);
  const edits = extractToolEdits(part);
  const writtenContent = extractWrittenContent(part);

  if (tool === "edit" && edits && edits.length > 0) {
    return (
      <div className="p-2 overflow-x-auto text-xs">
        {filePath && (
          <div className="text-[11px] font-mono text-muted-foreground mb-1">
            {filePath}
          </div>
        )}
        {edits.map((e, idx) => (
          <DiffView key={idx} oldText={e.oldText} newText={e.newText} />
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
        <pre className="p-2 rounded bg-background/50 font-mono text-[11px] overflow-auto max-h-72">
          {writtenContent}
        </pre>
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
        <pre className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground/90 max-h-80 overflow-y-auto">
          {output}
        </pre>
      ) : (
        <span className="text-[11px] text-muted-foreground italic">
          (No output)
        </span>
      )}
    </div>
  );
}
