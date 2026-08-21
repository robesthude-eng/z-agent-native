import { RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "./ui/button";

interface PreviewPanelProps {
  url: string;
}

export function PreviewPanel({ url }: PreviewPanelProps) {
  const [key, setKey] = useState(0); // Used to force reload iframe
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: key is a restart signal, not a value read by the effect — pressing Refresh while a load is still hanging leaves `loading` at true, so without key the fresh iframe would inherit whatever is left of the previous attempt's 12s budget
  useEffect(() => {
    if (!loading) return;
    const t = setTimeout(() => {
      setLoading(false);
      setError("Preview load timeout");
    }, 12000);
    return () => clearTimeout(t);
  }, [loading, key]);

  const handleRefresh = () => {
    setError(null);
    setLoading(true);
    setKey((prev) => prev + 1);
  };

  const _handleOpenExternal = () => {
    // Disabled: opening workspace preview outside sandbox breaks isolation.
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background">
      <div className="flex items-center justify-between border-b border-border bg-card px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="flex items-center rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
            <span className="truncate max-w-[200px]">{url}</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={handleRefresh}
            title="Обновить"
            aria-label="Обновить"
          >
            <RefreshCw
              size={14}
              className={loading && url ? "animate-spin" : ""}
            />
          </Button>
        </div>
      </div>
      <div className="relative flex-1 bg-white">
        {/* Placeholder if url is missing */}
        {!url && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            Нет URL для предпросмотра
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-red-500 bg-background/80">
            <span>{error}</span>
            <Button size="sm" variant="ghost" onClick={handleRefresh}>
              Повторить
            </Button>
          </div>
        )}
        {url && (
          <iframe
            key={key}
            src={url}
            className="h-full w-full border-none"
            title="Предпросмотр"
            sandbox="allow-scripts allow-forms allow-popups"
            onLoad={() => {
              setLoading(false);
              setError(null);
            }}
            onError={() => {
              setLoading(false);
              setError("Failed to load preview iframe");
            }}
          />
        )}
      </div>
    </div>
  );
}
