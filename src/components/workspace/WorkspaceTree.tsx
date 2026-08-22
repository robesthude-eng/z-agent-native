/**
 * Строка дерева воркспейса и её потомки (этап 3.1, «дерево»).
 *
 * Вынесено из `Workspace.tsx` без изменения поведения: разметка, условия и
 * обработчики перенесены дословно, а всё, что раньше бралось из замыкания,
 * стало явным свойством. Список свойств длинный намеренно — он ровно и есть
 * та связность, которую разделение делает видимой.
 *
 * Визуальный проход (плотность, направляющие, действия по наведению) менял
 * только классы и служебные элементы разметки: набор свойств, обработчики и
 * порядок узлов остались прежними.
 *
 * ВНИМАНИЕ при чтении диффа: этот файл не покрыт ни одним тестом и не
 * проверялся сборкой — он написан в окружении без `npm ci`. Решения, которые
 * можно было проверить, вынесены отдельно в `./fileDecisions.ts`; здесь
 * осталась разметка, и её единственная проверка — чтение.
 */
import type { ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { t } from "@/i18n";
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

/**
 * Отступ уровня и левый край первой строки. Держатся в одном месте, потому
 * что по ним же рисуются направляющие линии: разъедься эти числа — линия
 * перестала бы совпадать с колонкой значков.
 */
const INDENT_STEP = 14;
const INDENT_BASE = 8;
/** Смещение направляющей до середины колонки со стрелкой раскрытия. */
const GUIDE_OFFSET = 15;

/**
 * Буква статуса git вместо безымянной точки. Точка сообщала «файл чем-то
 * отличается», буква — чем именно, и совпадает со списком изменений над
 * деревом.
 */
const STATUS_LETTER: Record<string, string> = {
  modified: "M",
  added: "A",
  untracked: "U",
  deleted: "D",
  renamed: "R",
};

/** Кнопка действия в строке: появляется по наведению, на касании видна всегда (см. `.oc-reveal`). */
const ROW_ACTION =
  "oc-reveal inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-all hover:bg-accent hover:text-foreground active:scale-90";

/**
 * Подсветка совпадения с фильтром.
 *
 * Фильтр оставляет на экране десяток строк, но не говорит, чем именно они
 * подошли: совпасть могло имя папки выше по пути. Выделение показывает место
 * совпадения, а не только сам факт.
 */
function highlightMatch(name: string, filter: string): ReactNode {
  const needle = filter.trim().toLowerCase();
  if (!needle) return name;
  const at = name.toLowerCase().indexOf(needle);
  if (at === -1) return name;
  return (
    <>
      {name.slice(0, at)}
      <span className="rounded-[3px] bg-warning/25 text-foreground">
        {name.slice(at, at + needle.length)}
      </span>
      {name.slice(at + needle.length)}
    </>
  );
}

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
    const isActive = !node.isDir && activeFilePath === node.path;
    const status = gitFiles.find((g) => g.path === node.path)?.status;
    const statusColor = status ? STATUS_COLORS[status] : undefined;
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
        <span
          className={cn(
            "flex w-3.5 shrink-0 items-center justify-center transition-colors",
            isOpen ? "text-foreground/70" : "text-muted-foreground/70",
          )}
        >
          {isOpen ? (
            <ChevronDownIcon size={13} />
          ) : (
            <ChevronRightIcon size={13} />
          )}
        </span>
        <span
          className={cn(
            "shrink-0 transition-colors",
            isOpen ? "text-foreground/80" : "text-muted-foreground",
          )}
        >
          <FolderIcon size={15} />
        </span>
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
            "group relative flex h-7 cursor-pointer select-none items-center gap-1.5 rounded-lg pr-1 transition-colors",
            // Тон темы, а не `text-white`: подложка выделения в светлой теме
            // почти белая, и открытый файл на ней пропадал.
            isActive
              ? "bg-accent text-foreground"
              : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
          )}
          style={{ paddingLeft: INDENT_BASE + depth * INDENT_STEP }}
        >
          {/* Открытый файл помечен полосой у края, а не только подложкой:
              подложка `bg-accent` отличается от фона на пару процентов
              яркости и в светлой теме почти не читается. */}
          {isActive && (
            <span
              aria-hidden="true"
              className="pointer-events-none absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-foreground/70"
            />
          )}
          {renamingPath === node.path ? (
            <>
              {nodeIcon}
              <Input
                autoFocus
                className="h-6 min-w-0 flex-1 rounded-md px-1.5 font-mono text-[12px]"
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
              className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              onClick={() =>
                node.isDir
                  ? toggleDir(node).catch(() => {})
                  : openFile(node.path).catch(() => {})
              }
              title={node.name}
            >
              {nodeIcon}
              <span
                className={cn(
                  "min-w-0 flex-1 truncate font-mono text-[12px]",
                  node.isDir && "font-medium",
                  isActive && "font-medium text-foreground",
                )}
              >
                {highlightMatch(node.name, filter)}
              </span>
            </button>
          )}
          {status && statusColor && (
            <span
              className="shrink-0 rounded px-1 text-[10px] font-semibold leading-[15px]"
              style={{
                color: statusColor,
                background: `color-mix(in srgb, ${statusColor} 16%, transparent)`,
              }}
              title={status}
            >
              {STATUS_LETTER[status] ?? "•"}
            </span>
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
                    className={ROW_ACTION}
                    title={t("workspace_tree.pereimenovat")}
                    aria-label={t("workspace_tree.pereimenovat")}
                  >
                    <RenameIcon size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteItem(node).catch(() => {});
                    }}
                    className={cn(
                      ROW_ACTION,
                      "hover:bg-destructive/15 hover:text-destructive",
                    )}
                    title={t("workspace.udalit")}
                    aria-label={t("workspace.udalit")}
                  >
                    <TrashIcon size={13} />
                  </button>
                </>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  downloadWorkspaceItem(node.path);
                }}
                className={ROW_ACTION}
                title={t("workspace_tree.skachat_fayl")}
                aria-label={t("workspace_tree.skachat_fayl")}
              >
                <DownloadIcon size={13} />
              </button>
            </>
          )}
        </div>
        {node.isDir && isOpen && node.children && node.children.length > 0 && (
          // Направляющая уровня. Без неё в глубоком дереве взгляд теряет, к
          // какой папке относится строка: отступ в 14 пикселей на глаз
          // считается только до третьего уровня.
          <div className="relative">
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 w-px bg-border"
              style={{ left: INDENT_BASE + depth * INDENT_STEP + GUIDE_OFFSET }}
            />
            {node.children.map((c) => renderNode(c, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return <>{nodes.map((n) => renderNode(n, 0))}</>;
}
