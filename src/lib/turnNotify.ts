import type { State } from "../store/types";

/** Короткий сигнал без аудиофайла: два тона через Web Audio. */
export function playDoneSound() {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const tone = (freq: number, at: number) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        ctx.currentTime + at + 0.25,
      );
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.3);
    };
    tone(880, 0);
    tone(1320, 0.14);
    setTimeout(() => void ctx.close().catch(() => {}), 800);
  } catch {
    /* звук — необязательное удобство */
  }
}

export function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

export async function requestNotificationPermission(): Promise<
  NotificationPermission | "unsupported"
> {
  if (!notificationsSupported()) return "unsupported";
  if (Notification.permission !== "default") return Notification.permission;
  return await Notification.requestPermission();
}

/**
 * Сообщить, что агент закончил ход. Системное уведомление показывается,
 * только когда вкладка не на экране или открыт другой чат — иначе
 * пользователь и так видит результат.
 */
export function notifyTurnDone(state: State, sid: string) {
  const s = state.appSettings;
  if (!s) return;
  const away =
    typeof document !== "undefined" &&
    (document.hidden || state.currentID !== sid);
  if (s.soundOnDone) playDoneSound();
  if (!s.notifyOnDone || !away || !notificationsSupported()) return;
  if (Notification.permission !== "granted") return;
  const title = state.sessions.find((x) => x.id === sid)?.title || "Z Agent";
  try {
    const n = new Notification("Агент закончил работу", {
      body: title,
      tag: `z-agent-done-${sid}`,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    /* на некоторых мобильных браузерах конструктор запрещён */
  }
}
