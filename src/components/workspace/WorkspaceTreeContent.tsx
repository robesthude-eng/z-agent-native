import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { t } from "@/i18n";
import { FolderPlusIcon, RefreshIcon, WarningIcon } from "../icons";
import WorkspaceTree from "./WorkspaceTree";
import type { TreeNode } from "./workspaceTreeHelpers";

const SKELETON_ROWS = [128, 96, 148, 84, 116, 72];

function hasVisibleMatch(nodes: TreeNode[], filter: string): boolean {
  const needle = filter.trim().toLowerCase();
  if (!needle) return true;
  const walk = (list: TreeNode[]): boolean =>
    list.some(
      (node) =>
        node.path.toLowerCase().includes(needle) ||
        (node.children ? walk(node.children) : false),
    );
  return walk(nodes);
}

interface WorkspaceTreeContentProps {
  sessionId: string | null;
  tree: TreeNode[];
  filter: string;
  expanded: Set<string>;
  gitFiles: { path: string; status?: string }[];
  activeFilePath: string | null;
  renamingPath: string | null;
  renameValue: string;
  loading: boolean;
  error: string | null;
  onClearFilter: () => void;
  onRetry: () => void;
  setRenameValue: (value: string) => void;
  setRenamingPath: (value: string | null) => void;
  submitRename: (path: string) => Promise<void>;
  toggleDir: (node: TreeNode) => Promise<void>;
  openFile: (path: string) => Promise<void>;
  deleteItem: (node: TreeNode) => Promise<void>;
  downloadWorkspaceItem: (path: string) => void;
}

export function WorkspaceTreeContent({
  sessionId,
  tree,
  filter,
  expanded,
  gitFiles,
  activeFilePath,
  renamingPath,
  renameValue,
  loading,
  error,
  onClearFilter,
  onRetry,
  setRenameValue,
  setRenamingPath,
  submitRename,
  toggleDir,
  openFile,
  deleteItem,
  downloadWorkspaceItem,
}: WorkspaceTreeContentProps) {
  return (
    <ScrollArea className="min-h-0 w-full flex-1">
      <div className="px-2 py-2 pb-8">
        {!sessionId ? (
          <div className="flex flex-col items-center justify-center gap-3 px-4 py-12 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-muted/60 text-muted-foreground">
              <FolderPlusIcon size={22} />
            </span>
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                Воркспейс не выбран
              </p>
              <p className="max-w-[240px] text-xs leading-relaxed text-muted-foreground">
                {t("workspace.vyberite_ili_sozdayte_chat")}
              </p>
            </div>
          </div>
        ) : (
          <>
            {loading && tree.length === 0 && (
              <div
                className="space-y-1 py-1"
                aria-busy="true"
                aria-live="polite"
              >
                <span className="sr-only">
                  {t("workspace.zagruzka_faylov")}
                </span>
                {SKELETON_ROWS.map((width, index) => (
                  <div
                    key={width}
                    className="flex h-7 items-center gap-2"
                    style={{ paddingLeft: 8 + (index % 3) * 14 }}
                  >
                    <span className="oc-skeleton h-3.5 w-3.5 shrink-0" />
                    <span className="oc-skeleton h-3" style={{ width }} />
                  </div>
                ))}
              </div>
            )}
            {error && (
              <div className="mx-0.5 mb-2 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                <span className="mt-0.5 shrink-0">
                  <WarningIcon size={14} />
                </span>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="break-words leading-relaxed">{error}</div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs text-destructive hover:bg-destructive/15 hover:text-destructive"
                    onClick={onRetry}
                  >
                    {t("workspace.povtorit")}
                  </Button>
                </div>
              </div>
            )}
            {!loading && tree.length === 0 && !error && (
              <div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
                <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <FolderPlusIcon size={18} />
                </span>
                <p className="text-xs text-foreground">
                  {t("workspace.faylov_poka_net_v_workspace_etogo")}
                </p>
                <p className="max-w-[220px] text-[11px] leading-relaxed text-muted-foreground">
                  {t("workspace.sozdayte_fayl_knopkoy_vyshe_zagruzite")}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-1 h-8 gap-1.5 text-xs"
                  onClick={onRetry}
                >
                  <RefreshIcon size={13} />
                  {t("workspace.obnovit")}
                </Button>
              </div>
            )}
            <WorkspaceTree
              nodes={tree}
              filter={filter}
              expanded={expanded}
              gitFiles={gitFiles}
              activeFilePath={activeFilePath}
              renamingPath={renamingPath}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              setRenamingPath={setRenamingPath}
              submitRename={submitRename}
              toggleDir={toggleDir}
              openFile={openFile}
              deleteItem={deleteItem}
              downloadWorkspaceItem={downloadWorkspaceItem}
            />
            {tree.length > 0 && !hasVisibleMatch(tree, filter) && (
              <div className="flex flex-col items-center gap-1 px-3 py-8 text-center">
                <p className="text-xs text-muted-foreground">
                  {t("workspace.nichego_ne_naydeno")}
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={onClearFilter}
                >
                  {t("workspace.ochistit_filtr")}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </ScrollArea>
  );
}
