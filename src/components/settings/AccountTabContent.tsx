import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/lib/toast";
import { api } from "../../api/client";
import { useStore } from "../../store/useStore";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives";

/** Та же нижняя граница, что и на сервере (routes/auth.mjs). */
const MIN_PASSWORD_LENGTH = 12;

/**
 * Раздел «Аккаунт»: сведения о вошедшем пользователе и смена пароля.
 * Сервер сам требует текущий пароль и разлогинивает остальные устройства —
 * здесь только валидация формы и понятные сообщения.
 */
export function AccountTabContent() {
  const currentUser = useStore((s) => s.currentUser);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [repeatPassword, setRepeatPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit =
    !busy &&
    currentPassword.length > 0 &&
    newPassword.length >= MIN_PASSWORD_LENGTH &&
    newPassword === repeatPassword;

  const submit = async () => {
    setError(null);
    if (newPassword !== repeatPassword) {
      setError("Новый пароль и подтверждение не совпадают.");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`Минимальная длина пароля — ${MIN_PASSWORD_LENGTH} символов.`);
      return;
    }
    setBusy(true);
    try {
      const res = await api.changePassword(currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setRepeatPassword("");
      toast(
        "success",
        res.revokedSessions > 0
          ? `Пароль изменён. Другие устройства (${res.revokedSessions}) разлогинены.`
          : "Пароль изменён.",
      );
    } catch (e: unknown) {
      const raw = (e as Error)?.message || "";
      // Сообщения сервера приходят внутри строки "403 Forbidden {json}".
      if (raw.includes("Current password is incorrect")) {
        setError("Текущий пароль неверный.");
      } else if (raw.includes("must differ")) {
        setError("Новый пароль должен отличаться от текущего.");
      } else if (raw.includes("Too many") || raw.includes("429")) {
        setError("Слишком много попыток. Повторите позже.");
      } else {
        setError(raw || "Не удалось изменить пароль.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <SettingsSection title="Профиль" description="Текущая учётная запись.">
        <SettingsCard>
          <SettingsRow
            label={currentUser?.email ?? "—"}
            description={
              currentUser?.role === "admin"
                ? "Администратор — доступны разделы администрирования"
                : "Обычный пользователь"
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Пароль"
        description="После смены пароля все остальные устройства будут разлогинены, текущее — останется."
      >
        <SettingsCard>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (canSubmit) submit().catch(() => {});
            }}
          >
            <div className="space-y-4 p-4">
              <div className="space-y-1.5">
                <Label htmlFor="current-password">Текущий пароль</Label>
                <Input
                  id="current-password"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-password">Новый пароль</Label>
                <Input
                  id="new-password"
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Минимум {MIN_PASSWORD_LENGTH} символов.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="repeat-password">Повторите новый пароль</Label>
                <Input
                  id="repeat-password"
                  type="password"
                  autoComplete="new-password"
                  value={repeatPassword}
                  onChange={(e) => setRepeatPassword(e.target.value)}
                />
              </div>
              {error && (
                <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
                  {error}
                </p>
              )}
            </div>
            {/* Классический футер формы: действие справа, отделено линией. */}
            <div className="flex justify-end border-t border-border bg-muted/30 px-4 py-3">
              <Button type="submit" disabled={!canSubmit}>
                {busy ? "Сохранение…" : "Изменить пароль"}
              </Button>
            </div>
          </form>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
