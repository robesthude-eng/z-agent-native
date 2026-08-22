import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "@/lib/toast";
import { api } from "../../api/client";
import { useStore } from "../../store/useStore";
import { SettingsCard, SettingsRow, SettingsSection } from "./primitives";
import { t, tf } from "@/i18n";

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
      setError(t("account_tab_content.novyy_parol_i_podtverzhdenie_ne_sovpadayut"));
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(tf("account_tab_content.minimalnaya_dlina_parolya_0_simvolov", [MIN_PASSWORD_LENGTH]));
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
          ? tf("account_tab_content.parol_izmenen_drugie_ustroystva_0_razloginen", [res.revokedSessions])
          : t("account_tab_content.parol_izmenen"),
      );
    } catch (e: unknown) {
      const raw = (e as Error)?.message || "";
      // Сообщения сервера приходят внутри строки "403 Forbidden {json}".
      if (raw.includes("Current password is incorrect")) {
        setError(t("account_tab_content.tekuschiy_parol_nevernyy"));
      } else if (raw.includes("must differ")) {
        setError(t("account_tab_content.novyy_parol_dolzhen_otlichatsya_ot_tekuscheg"));
      } else if (raw.includes("Too many") || raw.includes("429")) {
        setError(t("account_tab_content.slishkom_mnogo_popytok_povtorite_pozzhe"));
      } else {
        setError(raw || t("account_tab_content.ne_udalos_izmenit_parol"));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-8">
      <SettingsSection title={t("account_tab_content.profil")} description={t("account_tab_content.tekuschaya_uchetnaya_zapis")}>
        <SettingsCard>
          <SettingsRow
            label={currentUser?.email ?? "—"}
            description={
              currentUser?.role === "admin"
                ? t("account_tab_content.administrator_dostupny_razdely_administrirov")
                : t("account_tab_content.obychnyy_polzovatel")
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title={t("login_page.parol")}
        description={t("account_tab_content.posle_smeny_parolya_vse_ostalnye_ustroystva")}
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
                <Label htmlFor="current-password">{t("account_tab_content.tekuschiy_parol")}</Label>
                <Input
                  id="current-password"
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-password">{t("account_tab_content.novyy_parol")}</Label>
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
                <Label htmlFor="repeat-password">{t("account_tab_content.povtorite_novyy_parol")}</Label>
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
                {busy ? t("account_tab_content.sohranenie") : t("account_tab_content.izmenit_parol")}
              </Button>
            </div>
          </form>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
