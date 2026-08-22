import type React from "react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { useStore } from "../store/useStore";
import { t } from "@/i18n";

export default function LoginPage() {
  const login = useStore((s) => s.login);
  const register = useStore((s) => s.register);
  const [isRegistering, setIsRegistering] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const cleanEmail = email.trim();
    if (!cleanEmail?.includes("@")) {
      setError(t("login_page.vvedite_korrektnyy_email_adres"));
      return;
    }
    if (!password) {
      setError(t("login_page.vvedite_parol"));
      return;
    }
    if (isRegistering && password.length < 12) {
      setError(t("login_page.parol_dolzhen_soderzhat_minimum_12_simvolov"));
      return;
    }
    if (isRegistering && password !== confirmPass) {
      setError(t("login_page.paroli_ne_sovpadayut"));
      return;
    }

    setLoading(true);
    const res = isRegistering
      ? await register(cleanEmail, password)
      : await login(cleanEmail, password);
    setLoading(false);

    if (!res.ok) {
      setError(res.error || t("login_page.oshibka_avtorizacii"));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 backdrop-blur-sm p-4 overflow-y-auto safe-top safe-bottom">
      <Card className="w-full max-w-md border-border shadow-lg">
        <CardHeader className="items-center text-center space-y-3 pb-2">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-card font-mono text-base font-bold text-primary">
            &gt;_
          </div>
          <h2 className="text-xl font-semibold tracking-tight">
            {isRegistering ? t("login_page.registraciya") : t("login_page.vhod")}
          </h2>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1">
            <button
              type="button"
              className={cn(
                "rounded-lg px-3 py-2 text-sm font-medium transition",
                !isRegistering
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => {
                setIsRegistering(false);
                setError(null);
              }}
            >
              Вход
            </button>
            <button
              type="button"
              className={cn(
                "rounded-lg px-3 py-2 text-sm font-medium transition",
                isRegistering
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => {
                setIsRegistering(true);
                setError(null);
              }}
            >
              Регистрация
            </button>
          </div>

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                placeholder="name@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                autoComplete="email"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">{t("login_page.parol")}</Label>
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete={
                  isRegistering ? "new-password" : "current-password"
                }
              />
            </div>

            {isRegistering && (
              <div className="space-y-2">
                <Label htmlFor="confirm">{t("login_page.podtverdite_parol")}</Label>
                <Input
                  id="confirm"
                  type="password"
                  placeholder="••••••••"
                  value={confirmPass}
                  onChange={(e) => setConfirmPass(e.target.value)}
                  required
                  autoComplete="new-password"
                />
              </div>
            )}

            <Button type="submit" className="w-full h-10" disabled={loading}>
              {loading
                ? t("login_page.podozhdite")
                : isRegistering
                  ? t("login_page.zaregistrirovatsya")
                  : t("login_page.voyti")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
