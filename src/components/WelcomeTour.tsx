import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStore } from "../store/useStore";
import { CloseIcon } from "./icons";
import { t } from "@/i18n";

interface TourStep {
  emoji: string;
  title: string;
  body: string;
  hint?: string;
}

const STEPS: TourStep[] = [
  {
    emoji: "👋",
    title: t("welcome_tour.eto_z_agent"),
    body:
      t("welcome_tour.postavte_zadachu_obychnym_yazykom_agent_sam"),
    hint:
      t("welcome_tour.esli_dlya_resheniya_deystvitelno_nuzhny_vash"),
  },
  {
    emoji: "⚡",
    title: t("welcome_tour.avtonomnaya_rabota"),
    body:
      t("welcome_tour.vo_vremya_zadachi_v_chate_viden"),
    hint:
      t("welcome_tour.kvadratnaya_knopka_v_pole_vvoda_stop"),
  },
  {
    emoji: "📁",
    title: t("welcome_tour.proekt_i_izmeneniya"),
    body:
      t("welcome_tour.knopka_papki_v_verhney_stroke_otkryvaet"),
    hint:
      t("welcome_tour.kazhdyy_chat_poluchaet_svoy_izolirovannyy_wo"),
  },
  {
    emoji: "🖥️",
    title: t("welcome_tour.terminal_i_predprosmotr"),
    body:
      t("welcome_tour.ikonka_terminala_otkryvaet_konsol_proekta_a"),
    hint:
      t("welcome_tour.na_kompyutere_navedite_na_ikonku_chtoby"),
  },
  {
    emoji: "🔑",
    title: t("welcome_tour.svoi_modeli_i_klyuchi"),
    body:
      t("welcome_tour.podklyuchayte_nuzhnyh_provayderov_i_modeli_s"),
    hint:
      t("welcome_tour.nastroyki_modeli_i_api_klyuchi_parol"),
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
 * клики за своими пределами. Закрыть тур можно Esc или крестиком.
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
      aria-label={t("welcome_tour.znakomstvo_s_z_agent")}
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
            title={t("welcome_tour.propustit_znakomstvo")}
            aria-label={t("welcome_tour.propustit_znakomstvo")}
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
