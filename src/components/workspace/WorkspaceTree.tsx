/**
 * Строка дерева воркспейса и её потомки (этап 3.1, «дерево»).
 *
 * Вынесено из `Workspace.tsx` без единого изменения поведения: разметка,
 * условия и обработчики перенесены дословно, а всё, что раньше бралось из
 * замыкания, стало явным свойством. Список свойств длинный намеренно — он
 * ровно и есть та связность, которую разделение делает видимой. Прятать её за
 * контекстом значило бы перенести проблему, а не решить.
 *
 * ВНИМАНИЕ при чтении диффа: этот файл не покрыт ни одним тестом и не
 * проверялся сборкой — он написан в окружении без `npm ci`. Решения, которые
 * можно было проверить, вынесены отдельно в `./fileDecisions.ts`; здесь
 * осталась разметка, и её единственная проверка — чтение.
 */
import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ArchiveFileIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  FileIcon,
  FolderIcon,
  ImageFileIcon,
  RenameIcon,
  TrashIcon,
} from "../icons";
import { editability } from "./fileDecisions";
import { fileVisual } from "./fileVisual";
import { STATUS_COLORS, type TreeNode } from "./workspaceTreeHelpers";
import { t } from "@/i18n";

export interface WorkspaceTreeProps {
  nodes: TreeNode[];
  filter: string;
  expanded: Set<string>;
  gitFiles: { path: string; status?: string }[];
  activeFilePath: string | null;
  renamingPath: string | null;
  renameValue: string;
  setRenameValue: (v: string) => void;
  setRenamingPath: (v: string | null) => void;
  submitRename: (path: string) => Promise<void>;
  toggleDir: (node: TreeNode) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  deleteItem: (node: TreeNode) => Promise<void>;
  downloadWorkspaceItem: (path: string) => void;
}

export default function WorkspaceTree({
  nodes,
  filter,
  expanded,
  gitFiles,
  activeFilePath,
  renamingPath,
  renameValue,
  setRenameValue,
  setRenamingPath,
  submitRename,
  toggleDir,
  openFile,
  deleteItem,
  downloadWorkspaceItem,
}: WorkspaceTreeProps) {
  const isEditablePath = (path: string) => editability(path).editable;

  const renderNode = (node: TreeNode, depth: number): ReactNode => {
    if (filter && !node.path.toLowerCase().includes(filter.toLowerCase())) {
      const hasMatch = node.children?.some((c) =>
        c.path.toLowerCase().includes(filter.toLowerCase()),
      );
      if (!hasMatch) return null;
    }
    const isOpen = expanded.has(node.path);
    const status = gitFiles.find((g) => g.path === node.path)?.status;
    // Тип файла виден цветом и — где это осмысленно — силуэтом значка.
    // Решение «имя → семейство» живёт в `fileVisual.ts` и проверяется там же;
    // здесь только подстановка.
    const visual = node.isDir ? null : fileVisual(node.name);
    const GlyphIcon =
      visual?.glyph === "image"
        ? ImageFileIcon
        : visual?.glyph === "archive"
          ? ArchiveFileIcon
          : FileIcon;
    const nodeIcon = node.isDir ? (
      <>
        {isOpen ? (
          <ChevronDownIcon size={14} />
        ) : (
          <ChevronRightIcon size={14} />
        )}
        <FolderIcon size={15} />
      </>
    ) : (
      <>
        <span className="w-3.5 shrink-0" />
        <span className="shrink-0" style={{ color: visual?.color }}>
          <GlyphIcon size={15} />
        </span>
      </>
    );
    return (
      <div key={node.path}>
        <div
          className={cn(
            "group flex cursor-pointer select-none items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-accent hover:text-foreground",
            node.isDir && "text-muted-foreground",
            // Тон темы, а не `text-white`: подложка выделения `bg-accent` в
            // светлой теме почти белая, и открытый файл на ней пропадал.
            !node.isDir &&
              activeFilePath === node.path &&
              "bg-accent text-foreground",
          )}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          {renamingPath === node.path ? (
            <>
              {nodeIcon}
              <Input
                autoFocus
                className="h-6 min-w-0 flex-1 rounded px-1.5 font-mono text-[11px]"
                value={renameValue}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={() => {
                  submitRename(node.path).catch(() => {});
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    submitRename(node.path).catch(() => {});
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    setRenamingPath(null);
                  }
                }}
              />
            </>
          ) : (
            // Открытие узла — настоящая кнопка, а не onClick на всей строке: в
            // строке живут поле переименования и кнопки действий, вложить их
            // внутрь кнопки нельзя, а div-у не хватало клавиатуры.
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              onClick={() =>
                node.isDir
                  ? toggleDir(node).catch(() => {})
                  : openFile(node.path).catch(() => {})
              }
            >
              {nodeIcon}
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
                {node.name}
              </span>
            </button>
          )}
          {status && (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ background: STATUS_COLORS[status] }}
              title={status}
            />
          )}
          {renamingPath !== node.path && (
            <>
              {isEditablePath(node.path) && (
                <>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setRenameValue(node.name);
                      setRenamingPath(node.path);
                    }}
                    className="opacity-0 group-hover:opacity-100 hover:text-foreground transition flex-shrink-0"
                    title={t("workspace_tree.pereimenovat")}
                    aria-label={t("workspace_tree.pereimenovat")}
                  >
                    <RenameIcon size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteItem(node).catch(() => {});
                    }}
                    className="opacity-0 group-hover:opacity-100 hover:text-red-400 transition flex-shrink-0"
                    title={t("workspace.udalit")}
                    aria-label={t("workspace.udalit")}
                  >
                    <TrashIcon size={14} />
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  downloadWorkspaceItem(node.path);
                }}
                className="opacity-0 group-hover:opacity-100 hover:text-foreground transition flex-shrink-0"
                title={t("workspace_tree.skachat_fayl")}
                aria-label={t("workspace_tree.skachat_fayl")}
              >
                <DownloadIcon size={14} />
              </button>
            </>
          )}
        </div>
        {node.isDir &&
          isOpen &&
          node.children?.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return <>{nodes.map((n) => renderNode(n, 0))}</>;
}
