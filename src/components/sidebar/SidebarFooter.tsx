import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { copyText } from "@/lib/clipboard";
import { toast } from "@/lib/toast";
import { LogoutIcon, MoonIcon, SettingsIcon, SunIcon, UserIcon } from "../icons";
import { t, tf } from "@/i18n";

function SidebarUserEmail({ email }: { email: string }) {
  const handleClick = () => {
    copyText(email).then((ok) => {
      if (ok) toast("success", tf("sidebar.email_skopirovan_0", [email]));
      else toast("error", t("sidebar.ne_udalos_skopirovat_email"));
    });
  };

  return (
    <div className="relative flex-1 min-w-0">
      <button
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-muted transition text-left"
        onClick={handleClick}
        title={tf("sidebar.skopirovat_email_0", [email])}
        type="button"
      >
        <UserIcon size={14} />
        <span className="truncate flex-1 text-muted-foreground">{email}</span>
      </button>
    </div>
  );
}

interface SidebarFooterProps {
  theme: string;
  onToggleTheme: () => void;
  onOpenSettings: () => void;
  currentUser: { email?: string } | null;
  authedCount: number;
  onLogout: () => void;
}

export function SidebarFooter({
  theme,
  onToggleTheme,
  onOpenSettings,
  currentUser,
  authedCount,
  onLogout,
}: SidebarFooterProps) {
  return (
    <div className="p-3">
      <Separator className="mb-3" />
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          {currentUser?.email ? (
            <SidebarUserEmail email={currentUser.email} />
          ) : (
            <span className="flex-1" />
          )}

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-lg"
            onClick={onToggleTheme}
            title={
              theme === "dark"
                ? t("sidebar.svetlaya")
                : t("sidebar.temnaya")
            }
          >
            {theme === "dark" ? <SunIcon size={15} /> : <MoonIcon size={15} />}
          </Button>

          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 rounded-lg relative"
            onClick={onOpenSettings}
            title={t("settings_panel.nastroyki")}
          >
            <SettingsIcon size={15} />
            {authedCount > 0 && (
              <Badge
                variant="secondary"
                className="absolute -top-1 -right-1 h-4 w-4 p-0 flex items-center justify-center text-[9px]"
              >
                {authedCount}
              </Badge>
            )}
          </Button>

          {currentUser && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10"
              onClick={onLogout}
              title={t("sidebar.vyyti_iz_akkaunta")}
            >
              <LogoutIcon size={15} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
