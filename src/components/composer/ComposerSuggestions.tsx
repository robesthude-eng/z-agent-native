import type { FileNode } from "@/api/types";
import { cn } from "@/lib/utils";

export interface ComposerCommand {
  cmd: string;
  hint: string;
  insert: string;
}

interface ComposerSuggestionsProps {
  commands: ComposerCommand[];
  files: FileNode[];
  commandIndex: number;
  fileIndex: number;
  onCommand: (command: ComposerCommand) => void;
  onFile: (file: FileNode) => void;
}

export function ComposerSuggestions({
  commands,
  files,
  commandIndex,
  fileIndex,
  onCommand,
  onFile,
}: ComposerSuggestionsProps) {
  if (commands.length === 0 && files.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 z-30 mb-2 overflow-hidden rounded-xl border border-border bg-card shadow-xl">
      {commands.map((command, index) => (
        <button
          key={command.cmd}
          type="button"
          className={cn(
            "flex w-full items-center gap-2 px-3 py-2 text-left text-xs",
            index === commandIndex % commands.length
              ? "bg-accent text-foreground"
              : "text-muted-foreground",
          )}
          onClick={() => onCommand(command)}
        >
          <span className="font-mono font-semibold">{command.cmd}</span>
          <span className="truncate opacity-70">{command.hint}</span>
        </button>
      ))}
      {commands.length === 0 &&
        files.map((file, index) => (
          <button
            key={file.path}
            type="button"
            className={cn(
              "flex w-full items-center gap-2 px-3 py-2 text-left text-xs",
              index === fileIndex % files.length
                ? "bg-accent text-foreground"
                : "text-muted-foreground",
            )}
            onClick={() => onFile(file)}
          >
            <span aria-hidden="true">📄</span>
            <span className="truncate font-mono">{file.path}</span>
          </button>
        ))}
    </div>
  );
}
