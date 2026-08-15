import type { ReactNode } from "react";
import {
  BashIcon,
  DefaultToolIcon,
  EditIcon,
  FileIcon,
  GlobIcon,
  GrepIcon,
  ListFilesIcon,
  QuestionIcon,
  TaskIcon,
  WebFetchIcon,
  WebSearchIcon,
  WriteIcon,
} from "../components/icons";

export function toolIcon(name?: string | null): ReactNode {
  // Defensive: callers can accidentally pass an object (e.g. a streamed tool
  // reference {messageID, callID} during streaming); fall back to default.
  if (typeof name !== "string" || !name) return <DefaultToolIcon size={13} />;
  const n = name.toLowerCase();
  if (n === "read") return <FileIcon size={13} />;
  if (n === "edit" || n === "applypatch" || n === "apply_patch") return <EditIcon size={13} />;
  if (n === "write") return <WriteIcon size={13} />;
  if (n === "bash" || n === "cmd" || n === "shell" || n === "ensure_environment" || n === "environment_status")
    return <BashIcon size={13} />;
  if (n === "glob") return <GlobIcon size={13} />;
  if (n === "grep") return <GrepIcon size={13} />;
  if (n === "list" || n === "ls") return <ListFilesIcon size={13} />;
  if (n === "task") return <TaskIcon size={13} />;
  if (n === "webfetch" || n === "fetch") return <WebFetchIcon size={13} />;
  if (n === "websearch" || n === "search") return <WebSearchIcon size={13} />;
  if (n === "question") return <QuestionIcon size={13} />;
  return <DefaultToolIcon size={13} />;
}
