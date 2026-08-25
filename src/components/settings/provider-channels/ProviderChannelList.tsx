import type { ProviderChannel } from "@/api/providerChannels";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { CheckIcon } from "../../icons";
import { API_FORMAT_LABELS, providerColor } from "../providerChannelModel";

interface ProviderChannelListProps {
  channels: ProviderChannel[];
  selectedId: string | null;
  loading: boolean;
  onAdd: () => void;
  onSelect: (id: string) => void;
}

export function ProviderChannelList({
  channels,
  selectedId,
  loading,
  onAdd,
  onSelect,
}: ProviderChannelListProps) {
  return (
    <aside className="flex min-h-0 flex-col border-b border-border bg-muted/20 md:border-b-0 md:border-r">
      <div className="border-b border-border p-3">
        <Button className="w-full" size="sm" onClick={onAdd}>
          {t("provider_channel_manager.dobavit_provaydera")}
        </Button>
      </div>
      <div className="max-h-56 overflow-y-auto p-2 md:max-h-none md:flex-1">
        {loading ? (
          <div className="px-2 py-4 text-xs text-muted-foreground">
            {t("provider_channel_manager.zagruzka")}
          </div>
        ) : (
          channels.map((channel) => (
            <button
              key={channel.id}
              type="button"
              onClick={() => onSelect(channel.id)}
              className={cn(
                "mb-1 flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                selectedId === channel.id
                  ? "bg-background shadow-sm"
                  : "hover:bg-muted/70",
              )}
            >
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-white"
                style={{ background: providerColor(channel.id) }}
              >
                {channel.name.charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 truncate text-xs font-medium">
                  {channel.name}
                  {channel.connected && <CheckIcon size={12} />}
                </span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {API_FORMAT_LABELS[channel.protocol]}
                </span>
              </span>
              {!channel.enabled && (
                <span className="h-2 w-2 rounded-full bg-muted-foreground/40" />
              )}
            </button>
          ))
        )}
      </div>
    </aside>
  );
}
