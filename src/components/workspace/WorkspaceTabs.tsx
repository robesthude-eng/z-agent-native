import { useRef } from "react";

export type WorkspaceTab = "preview" | "files" | "code";
const TABS: WorkspaceTab[] = ["preview", "files", "code"];
const LABELS = { preview: "Превью", files: "Файлы", code: "Код" };
export function WorkspaceTabs({
  active,
  onSelect,
}: {
  active: WorkspaceTab;
  onSelect: (tab: WorkspaceTab) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={root}
      className="workspace-tabs"
      role="tablist"
      aria-label="Представление workspace"
    >
      {TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          tabIndex={active === tab ? 0 : -1}
          aria-selected={active === tab}
          aria-controls={`workspace-panel-${tab}`}
          id={`workspace-tab-${tab}`}
          onClick={() => onSelect(tab)}
          onKeyDown={(e) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key))
              return;
            e.preventDefault();
            const i = TABS.indexOf(tab);
            const next =
              e.key === "Home"
                ? TABS[0]
                : e.key === "End"
                  ? TABS[2]
                  : TABS[
                      (i + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) %
                        TABS.length
                    ];
            if (next) {
              onSelect(next);
              root.current
                ?.querySelector<HTMLButtonElement>(`#workspace-tab-${next}`)
                ?.focus();
            }
          }}
        >
          {LABELS[tab]}
        </button>
      ))}
    </div>
  );
}
