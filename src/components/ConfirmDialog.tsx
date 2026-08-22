import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Красная кнопка для необратимых действий: удаление, потеря правок. */
  destructive?: boolean;
}

type Resolver = (value: boolean) => void;

const ConfirmContext = createContext<
  ((options: ConfirmOptions) => Promise<boolean>) | null
>(null);

/**
 * Подтверждение действия средствами самого приложения.
 *
 * Нативный `window.confirm` блокирует поток, выглядит чужеродно на
 * телефоне и в WebView/PWA может быть подавлён — тогда он возвращает false
 * молча, и действие тихо не выполняется. Здесь — обычный диалог Radix
 * с ловушкой фокуса, Escape и role="dialog" из коробки.
 */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<Resolver | null>(null);

  const confirm = useCallback((next: ConfirmOptions) => {
    // Предыдущий незакрытый запрос считаем отменой: иначе его promise
    // никогда не разрешится и вызывающий код зависнет на await навсегда.
    resolverRef.current?.(false);
    setOptions(next);
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOptions(null);
    resolve?.(value);
  }, []);

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) settle(false);
    },
    [settle],
  );

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {options !== null && (
        <Dialog open={true} onOpenChange={handleOpenChange}>
          <DialogContent className="max-w-[min(26rem,calc(100vw-2rem))]">
            <DialogHeader>
              <DialogTitle>{options.title}</DialogTitle>
              {options.description ? (
                <DialogDescription>{options.description}</DialogDescription>
              ) : null}
            </DialogHeader>
            <div className="flex flex-col-reverse gap-2 px-5 pb-5 sm:flex-row sm:justify-end">
              <Button
                type="button"
                variant="outline"
                onClick={() => settle(false)}
              >
                {options.cancelLabel ?? t("confirm_dialog.otmena")}
              </Button>
              <Button
                type="button"
                variant={options.destructive ? "destructive" : "default"}
                onClick={() => settle(true)}
              >
                {options.confirmLabel ?? t("confirm_dialog.podtverdit")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </ConfirmContext.Provider>
  );
}

/**
 * Возвращает функцию `confirm(options): Promise<boolean>` — замена
 * нативного confirm без переписывания логики вызывающего кода.
 */
export function useConfirm() {
  const confirm = useContext(ConfirmContext);
  if (!confirm) {
    throw new Error(t("confirm_dialog.useconfirm_vyzvan_vne_confirmprovider"));
  }
  return confirm;
}
