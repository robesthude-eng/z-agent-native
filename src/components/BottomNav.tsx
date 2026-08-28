import { MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { useStore } from "../store/useStore";
import {
  BashIcon,
  MenuIcon,
  PreviewIcon,
  WorkspaceClosedIcon,
  WorkspaceOpenIcon,
} from "./icons";

export function BottomNav() {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const setSidebarOpen = useStore((s) => s.setSidebarOpen);
  const workspaceOpen = useStore((s) => s.workspaceOpen);
  const setWorkspaceOpen = useStore((s) => s.setWorkspaceOpen);

  const openModal = (kind: "terminal" | "preview" | "changes") => {
    window.dispatchEvent(
      new CustomEvent("z-agent:open-modal", { detail: kind }),
    );
  };

  const isChatActive = !workspaceOpen && !sidebarOpen;

  return (
    <nav
      aria-label="Мобильная навигация"
      className="md:hidden shrink-0 z-30 border-t border-border/80 bg-background/95 backdrop-blur-md px-2 py-1 safe-bottom"
    >
      <div className="grid grid-cols-5 items-center justify-items-center gap-1">
        {/* Кнопка: Меню чатов */}
        <button
          type="button"
          onClick={() => {
            setWorkspaceOpen(false);
            setSidebarOpen(!sidebarOpen);
          }}
          className={cn(
            "flex flex-col items-center justify-center gap-0.5 rounded-xl py-1 px-1 text-[10px] font-medium transition-all w-full",
            sidebarOpen
              ? "text-primary font-semibold"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span className="flex h-5 w-5 items-center justify-center">
            <MenuIcon />
          </span>
          <span>Чаты</span>
        </button>

        {/* Кнопка: Чат */}
        <button
          type="button"
          onClick={() => {
            setWorkspaceOpen(false);
            setSidebarOpen(false);
          }}
          className={cn(
            "flex flex-col items-center justify-center gap-0.5 rounded-xl py-1 px-1 text-[10px] font-medium transition-all w-full",
            isChatActive
              ? "text-primary font-semibold"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span className="flex h-5 w-5 items-center justify-center">
            <MessageSquare className="h-4 w-4" />
          </span>
          <span>Диалог</span>
        </button>

        {/* Кнопка: Файлы */}
        <button
          type="button"
          onClick={() => {
            setSidebarOpen(false);
            setWorkspaceOpen(!workspaceOpen);
          }}
          className={cn(
            "flex flex-col items-center justify-center gap-0.5 rounded-xl py-1 px-1 text-[10px] font-medium transition-all w-full",
            workspaceOpen
              ? "text-primary font-semibold"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span className="flex h-5 w-5 items-center justify-center">
            {workspaceOpen ? (
              <WorkspaceOpenIcon size={16} />
            ) : (
              <WorkspaceClosedIcon size={16} />
            )}
          </span>
          <span>Файлы</span>
        </button>

        {/* Кнопка: Превью */}
        <button
          type="button"
          onClick={() => openModal("preview")}
          className="flex flex-col items-center justify-center gap-0.5 rounded-xl py-1 px-1 text-[10px] font-medium transition-all text-muted-foreground hover:text-foreground w-full"
        >
          <span className="flex h-5 w-5 items-center justify-center">
            <PreviewIcon size={16} />
          </span>
          <span>Превью</span>
        </button>

        {/* Кнопка: Терминал */}
        <button
          type="button"
          onClick={() => openModal("terminal")}
          className="flex flex-col items-center justify-center gap-0.5 rounded-xl py-1 px-1 text-[10px] font-medium transition-all text-muted-foreground hover:text-foreground w-full"
        >
          <span className="flex h-5 w-5 items-center justify-center">
            <BashIcon size={16} />
          </span>
          <span>Консоль</span>
        </button>
      </div>
    </nav>
  );
}
