import { useEffect, useRef, useState } from "react";
import { t } from "@/i18n";
import type { AgentActivity } from "@/lib/agentActivity";

/** Restrained progress display derived from actual tools, never fake stages. */
export function AgentIndicator({ activity }: { activity: AgentActivity }) {
  const mountedAt = useRef(Date.now());
  const [now, setNow] = useState(() => Date.now());

  // Pause repainting in background tabs, but retain the true turn start time.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (document.visibilityState === "hidden") return;
      setNow(Date.now());
      timer = setInterval(() => setNow(Date.now()), 1000);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  const startedAt = activity.startedAt ?? mountedAt.current;
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="agent-progress" data-testid="agent-progress">
      <span className="agent-progress-dot" aria-hidden="true" />
      <div className="agent-progress-copy">
        {/* Only real state changes are announced; the clock remains outside. */}
        <div role="status" aria-live="polite" aria-atomic="true">
          <span className="agent-progress-label">{activity.label}</span>
          {activity.detail && (
            <span className="agent-progress-detail" title={activity.detail}>
              {activity.detail}
            </span>
          )}
        </div>
      </div>
      <span
        className="agent-progress-time"
        aria-hidden="true"
        title={t("agent_indicator.vremya_vypolneniya")}
      >
        {mm}:{ss}
      </span>
    </div>
  );
}

export default AgentIndicator;
