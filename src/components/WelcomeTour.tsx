import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStore } from "../store/useStore";
import { CloseIcon } from "./icons";

interface TourStep {
  /** Эмодзи вместо иконки: шаги — разовый экран, лишние SVG тут не нужны. */
  emoji: string;
  title: string;
  body: string;
  /** Необязательная подсказка «где это в интерфейсе». */
  hint?: string;
}

const STEPS: TourStep[] = [
  {
    emoji: "👋",
    title: "Это Z Agent",
    body:
      "AI-ассистент, который не только отвечает текстом, но и работает с файлами: " +
      "создаёт проекты, правит код, запускает команды в терминале.",
    hint: "Каждый чат получает свой изолированный workspace — файлы одного чата не видны другим.",
  },
  {
    emoji: "📁",
    title: "Файлы проекта — справа",
    body:
      "Панель Files показывает workspace текущего чата. Файлы можно открыть, " +
      "отредактировать и сохранить прямо здесь, создать новые, переименовать или удалить.",
    hint: "Открыть панель: кнопка workspace в верхней строке. Сохранение файла — Ctrl+S.",
  },
  {
    emoji: "🖥️",
    title: "Терминал",
    body:
      "Полноценная консоль внутри workspace чата: установить зависимости, " +
      "запустить сборку, посмотреть логи. Агент работает в том же каталоге.",
    hint: "Терминал открывается кнопкой в верхней строке.",
  },
  {
    emoji: "🔑",
    title: "Свои модели и ключи",
    body:
      "Подключите GPT, Claude, Gemini или другой поддерживаемый провайдер своим API-ключом. " +
      "Каталог моделей runtime получает напрямую у провайдера.",
    hint: "Настройки → Модели и API-ключи. Пароль меняется в разделе «Аккаунт и пароль».",
  },
];

/**
 * Приветственный тур первого запуска.
 *
 * Показывается один раз: отметка о прохождении лежит в пользовательских
 * настройках на сервере (см. store/prefsSync.ts), а не в localStorage, поэтому
 * второе устройство не начинает знакомство заново. Ждём `prefsSynced`, иначе
 * у существующего пользователя в новом браузере тур мигнул бы до синхронизации.
 *
 * НЕ модальное окно: карточка плавает поверх интерфейса, но не перехватывает
 * клики за своими пределами (обёртка `pointer-events-none`, сама карточка —
 * `pointer-events-auto`). Приложение уже требует ознакомиться с формой входа
 * и настройками без блокирующих модалок — тур не должен быть единственным
 * местом, где пользователь заперт: до захвата фокуса можно продолжать
 * работать (например, дописать текст в composer), а закрыть тур — Esc или
 * крестиком.
 */
export default function WelcomeTour() {
  const currentUser = useStore((s) => s.currentUser);
  const onboardingDone = useStore((s) => s.onboardingDone);
  const prefsSynced = useStore((s) => s.prefsSynced);
  const completeOnboarding = useStore((s) => s.completeOnboarding);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const [step, setStep] = useState(0);

  const visible = !!currentUser && !onboardingDone && prefsSynced;

  const finish = () => {
    completeOnboarding();
    setStep(0);
  };

  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        completeOnboarding();
        setStep(0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, completeOnboarding]);

  if (!visible) return null;

  const current = STEPS[step];
  if (!current) return null;
  const isLast = step === STEPS.length - 1;

  return (
    <div
      className="pointer-events-none fixed inset-0 z-[80] flex items-end justify-center p-4 sm:items-center sm:justify-end sm:pr-6"
      role="dialog"
      aria-label="Знакомство с Z Agent"
    >
      <div className="pointer-events-auto flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-e3">
        <div className="flex items-start justify-between gap-2 px-5 pt-5">
          <span className="text-3xl" aria-hidden="true">
            {current.emoji}
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground"
            onClick={finish}
            title="Пропустить знакомство"
            aria-label="Пропустить знакомство"
          >
            <CloseIcon size={16} />
          </Button>
        </div>

        <div className="space-y-2 px-5 pb-1 pt-2">
          <h2 className="text-lg font-semibold">{current.title}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {current.body}
          </p>
          {current.hint && (
            <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              {current.hint}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-4">
          <div className="flex items-center gap-1.5" aria-hidden="true">
            {STEPS.map((s, i) => (
              <span
                key={s.title}
                className={cn(
                  "h-1.5 rounded-full transition-all",
                  i === step ? "w-5 bg-primary" : "w-1.5 bg-border",
                )}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setStep((s) => s - 1)}
              >
                Назад
              </Button>
            )}
            {isLast ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    finish();
                    setSettingsOpen(true);
                  }}
                >
                  Открыть настройки
                </Button>
                <Button size="sm" onClick={finish}>
                  Начать
                </Button>
              </>
            ) : (
              <Button size="sm" onClick={() => setStep((s) => s + 1)}>
                Далее
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
