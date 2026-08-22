/**
 * Регистрация service worker'а (PWA: установка как приложение + офлайн-страница).
 *
 * Заменяет прежний SW_KILLSWITCH. Тот появился потому, что VitePWA прекэшировал
 * index.html и после пересборки dist клиент застревал на старом бандле с
 * ChunkLoadError. Новый public/sw.js не кэширует HTML вообще — причина того бага
 * устранена по построению, и снимать регистрацию больше не нужно.
 *
 * Наследие всё же убираем: регистрации со ЧУЖИМ адресом скрипта (старый
 * workbox мог жить не только на /sw.js) снимаем, а старые кэши удаляет сам
 * sw.js при активации. Перезагрузку страницу не форсируем: новая сборка
 * приезжает обычным запросом HTML, а внезапный reload посреди чата хуже,
 * чем ожидание следующего перехода.
 */
if (typeof window !== "undefined" && "serviceWorker" in navigator) {
  const registerServiceWorker = () => {
    navigator.serviceWorker
      .getRegistrations()
      .then((regs) => {
        for (const reg of regs) {
          const scriptUrl =
            reg.active?.scriptURL ||
            reg.waiting?.scriptURL ||
            reg.installing?.scriptURL ||
            "";
          if (scriptUrl && !scriptUrl.endsWith("/sw.js")) {
            reg.unregister().catch(() => undefined);
          }
        }
      })
      .catch(() => undefined)
      .then(() =>
        navigator.serviceWorker.register("/sw.js", {
          scope: "/",
          // Даже если промежуточный прокси закэшировал скрипт, браузер всегда
          // перепроверяет его в сети. Runtime дополнительно отдаёт sw.js с
          // Cache-Control: no-cache.
          updateViaCache: "none",
        }),
      )
      .catch(() => undefined);
  };

  // После первого рендера: регистрация не должна задерживать initial paint.
  if ("requestIdleCallback" in window) {
    (
      window as unknown as { requestIdleCallback: (cb: () => void) => void }
    ).requestIdleCallback(registerServiceWorker);
  } else {
    setTimeout(registerServiceWorker, 1500);
  }
}

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { initAutonomyUx } from "./lib/autonomyUx";
import { initSentryBrowser } from "./lib/sentry";
import "./index.css";
import "./autonomy-ui.css";
import { t } from "@/i18n";

initSentryBrowser();
initAutonomyUx();

const rootElement = document.getElementById("root");
if (!rootElement) {
  // Монтировать некуда: без броска здесь пользователь получил бы молча
  // пустую страницу, а в Sentry — ни одной записи о причине.
  throw new Error(t("main.ne_nayden_element_root_v_index"));
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
