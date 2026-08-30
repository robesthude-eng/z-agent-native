import type { ReactNode } from "react";
import {
  AudioIcon,
  BashIcon,
  ConvertIcon,
  DefaultToolIcon,
  DocumentIcon,
  EditIcon,
  FileIcon,
  FolderIcon,
  GlobIcon,
  GrepIcon,
  ImageGenIcon,
  ListFilesIcon,
  MediaInfoIcon,
  QuestionIcon,
  TaskIcon,
  VideoIcon,
  WebFetchIcon,
  WebSearchIcon,
  WriteIcon,
} from "../components/icons";

type IconComponent = (p: { size?: number }) => ReactNode;

/**
 * Значки инструментов.
 *
 * Держится в паре с `TOOL_LABEL_KEYS` из `lib/toolLabels`: таблицы расходились
 * молча — медиа-инструменты и `patch`/`todowrite`/`repo_map` давно получили
 * человеческие подписи, а значок у них оставался дефолтной шестерёнкой.
 * Парность проверяет `toolUtils.test.ts`.
 */
export const TOOL_ICONS: Record<string, IconComponent> = {
  read: FileIcon,
  edit: EditIcon,
  applypatch: EditIcon,
  apply_patch: EditIcon,
  patch: EditIcon,
  write: WriteIcon,
  bash: BashIcon,
  cmd: BashIcon,
  shell: BashIcon,
  ensure_environment: BashIcon,
  environment_status: BashIcon,
  ssh_tool: BashIcon,
  ssh: BashIcon,
  glob: GlobIcon,
  grep: GrepIcon,
  list: ListFilesIcon,
  ls: ListFilesIcon,
  todowrite: ListFilesIcon,
  todo: ListFilesIcon,
  task: TaskIcon,
  webfetch: WebFetchIcon,
  fetch: WebFetchIcon,
  websearch: WebSearchIcon,
  search: WebSearchIcon,
  question: QuestionIcon,
  repo_map: FolderIcon,
  generate_image: ImageGenIcon,
  generate_speech: AudioIcon,
  render_document: DocumentIcon,
  render_video: VideoIcon,
  convert_media: ConvertIcon,
  media_info: MediaInfoIcon,
};

export function toolIcon(name?: string | null): ReactNode {
  // Defensive: callers can accidentally pass an object (e.g. a streamed tool
  // reference {messageID, callID} during streaming); fall back to default.
  if (typeof name !== "string" || !name) return <DefaultToolIcon size={13} />;
  const Icon = TOOL_ICONS[name.toLowerCase()];
  return Icon ? <Icon size={13} /> : <DefaultToolIcon size={13} />;
}
