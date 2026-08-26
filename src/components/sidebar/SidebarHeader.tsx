import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { CloseIcon, NewChatIcon, SearchIcon } from "../icons";

export type DeepHit = { id: string; title: string; snippet: string };

interface SidebarHeaderProps {
  filter: string;
  setFilter: (val: string) => void;
  normalizedFilter: string;
  deepBusy: boolean;
  deepResults: DeepHit[] | null;
  runDeepSearch: () => void;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onClose: () => void;
}

export function SidebarHeader({
  filter,
  setFilter,
  normalizedFilter,
  deepBusy,
  deepResults,
  runDeepSearch,
  onSelectSession,
  onNewSession,
  onClose,
}: SidebarHeaderProps) {
  return (
    <>
      <div className="flex flex-col gap-2 px-3 pb-3 pt-3">
        <div className="flex items-center gap-2 w-full">
          <Button
            data-testid="new-chat-btn"
            className="h-9 flex-1 justify-start gap-2 rounded-xl border border-border bg-transparent text-[12px] font-medium text-foreground shadow-none hover:bg-accent"
            onClick={() => {
              onNewSession();
              onClose();
            }}
          >
            <NewChatIcon />
            <span>{t("shortcuts_overlay.novyy_chat")}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            title={t("panel_modal.zakryt")}
            aria-label={t("sidebar.zakryt_menyu")}
            className="md:hidden"
          >
            <CloseIcon />
          </Button>
        </div>
      </div>

      <div className="px-2 pt-2">
        <div className="relative">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
            <SearchIcon size={13} />
          </span>
          <input
            id="chat-filter-input"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("sidebar.poisk_chatov_ctrl_k")}
            aria-label={t("shortcuts_overlay.poisk_po_spisku_chatov")}
            className="w-full rounded-lg border border-border bg-muted/40 py-1.5 pl-8 pr-8 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:bg-background"
          />
          {filter && (
            <button
              type="button"
              onClick={() => setFilter("")}
              title={t("sidebar.ochistit_poisk")}
              aria-label={t("sidebar.ochistit_poisk")}
              className="absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <CloseIcon size={12} />
            </button>
          )}
        </div>

        {normalizedFilter && (
          <button
            type="button"
            className="mt-1.5 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-border px-2 py-1.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
            onClick={runDeepSearch}
            disabled={deepBusy}
          >
            <SearchIcon size={12} />
            {deepBusy
              ? t("sidebar.ischu_v_soobscheniyah")
              : t("sidebar.iskat_v_soobscheniyah_chatov")}
          </button>
        )}

        {deepResults && (
          <div className="mt-1.5 max-h-48 overflow-y-auto rounded-xl border border-border bg-card">
            {deepResults.length === 0 && (
              <p className="px-2.5 py-2 text-[11px] text-muted-foreground">
                {t("sidebar.sovpadeniy_v_soobscheniyah_net")}
              </p>
            )}
            {deepResults.map((r) => (
              <button
                key={r.id}
                type="button"
                className="block w-full px-2.5 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                onClick={() => {
                  onSelectSession(r.id);
                  onClose();
                }}
              >
                <span className="block truncate text-[11px] text-foreground">
                  {r.title}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  …{r.snippet}…
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
