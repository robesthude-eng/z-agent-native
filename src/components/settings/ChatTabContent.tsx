import { useState } from "react";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/toast";
import {
  notificationsSupported,
  playDoneSound,
  requestNotificationPermission,
} from "@/lib/turnNotify";
import type { SendKey } from "../../config/appSettings";
import { useStore } from "../../store/useStore";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSegmented,
  SettingsToggle,
} from "./primitives";

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform);

const SEND_OPTIONS: Array<{ id: SendKey; label: string }> = [
  { id: "enter", label: "Enter" },
  { id: "mod-enter", label: isMac ? "⌘ + Enter" : "Ctrl + Enter" },
];

function permissionLabel(p: NotificationPermission | "unsupported") {
  if (p === "granted") return "разрешены браузером";
  if (p === "denied") return "запрещены в настройках браузера";
  if (p === "unsupported") return "браузер не поддерживает";
  return "нужно разрешение браузера";
}

/** Раздел «Чат и уведомления». */
export function ChatTabContent() {
  const settings = useStore((s) => s.appSettings);
  const update = useStore((s) => s.setAppSettings);
  const [permission, setPermission] = useState<
    NotificationPermission | "unsupported"
  >(notificationsSupported() ? Notification.permission : "unsupported");

  const toggleNotify = async (on: boolean) => {
    if (!on) {
      update({ notifyOnDone: false });
      return;
    }
    const p = await requestNotificationPermission();
    setPermission(p);
    if (p !== "granted") {
      toast("error", "Браузер не разрешил уведомления");
      return;
    }
    update({ notifyOnDone: true });
  };

  return (
    <div className="space-y-8">
      <SettingsSection title="Отправка сообщений">
        <SettingsCard>
          <SettingsRow
            label="Отправлять по"
            description={
              settings.sendKey === "enter"
                ? "Shift + Enter — новая строка."
                : "Enter — новая строка. Удобно для длинных сообщений и кода."
            }
          >
            <SettingsSegmented
              ariaLabel="Клавиша отправки"
              value={settings.sendKey}
              options={SEND_OPTIONS}
              onChange={(sendKey) => update({ sendKey })}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Когда агент закончил"
        description="Удобно для долгих задач: можно переключиться на другое и вернуться по сигналу."
      >
        <SettingsCard>
          <SettingsRow
            label="Системное уведомление"
            description={`Показывается, если вкладка свёрнута или открыт другой чат · ${permissionLabel(permission)}`}
          >
            <SettingsToggle
              ariaLabel="Системное уведомление"
              checked={settings.notifyOnDone && permission === "granted"}
              disabled={permission === "unsupported" || permission === "denied"}
              onChange={(on) => void toggleNotify(on)}
            />
          </SettingsRow>
          <SettingsRow
            label="Звуковой сигнал"
            description="Короткий двойной сигнал."
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => playDoneSound()}
            >
              Прослушать
            </Button>
            <SettingsToggle
              ariaLabel="Звуковой сигнал"
              checked={settings.soundOnDone}
              onChange={(soundOnDone) => update({ soundOnDone })}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
