import { Check, Copy } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { t } from "@/i18n";

export default function CopyButton({
  text,
  title,
  className,
}: {
  text: string;
  title?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Релиз 3: только современный асинхронный Clipboard API. Синхронный
    // fallback через document.execCommand("copy") на больших полотнах кода
    // вешал вкладку на несколько секунд — удалён.
    copyText(text).then((ok) => {
      if (!ok) {
        toast("error", t("copy_button.ne_udalos_skopirovat_net_dostupa_k"));
        return;
      }
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    });
  };

  const label = copied ? t("copy_button.skopirovano") : (title ?? t("copy_button.kopirovat"));

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={cn(
        "h-7 w-7 rounded-lg text-muted-foreground hover:text-foreground",
        copied && "text-foreground hover:text-foreground",
        className,
      )}
      onClick={handleCopy}
      title={copied ? t("copy_button.skopirovano_2") : (title ?? t("copy_button.kopirovat"))}
      aria-label={label}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </Button>
  );
}
