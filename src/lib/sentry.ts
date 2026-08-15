/**
 * Browser Sentry bootstrap.
 * Requires VITE_SENTRY_DSN. Package @sentry/react is a real dependency.
 */
import * as Sentry from "@sentry/react";

let inited = false;

export function initSentryBrowser() {
  if (inited) return;
  inited = true;

  const dsn = import.meta.env.VITE_SENTRY_DSN;
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE || "production",
    // 1% трейсов: не выжигает месячный лимит Sentry.
    tracesSampleRate: 0.01,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: 0,
    maxBreadcrumbs: 30,
    // Обрезаем историю чата/стейт перед отправкой: сериализация
    // огромного стейта при ошибке сама способна подвесить вкладку.
    beforeSend: (event) => trimSentryEvent(event),
  });
}

const MAX_FIELD_CHARS = 4000;

function trimValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") {
    return value.length > MAX_FIELD_CHARS
      ? `${value.slice(0, MAX_FIELD_CHARS)}…[trimmed ${value.length - MAX_FIELD_CHARS} chars]`
      : value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 50)
      .map((v) => (depth < 4 ? trimValue(v, depth + 1) : "[trimmed]"));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value).slice(0, 50)) {
      out[k] = depth < 4 ? trimValue(v, depth + 1) : "[trimmed]";
    }
    return out;
  }
  return value;
}

function trimSentryEvent<
  E extends {
    extra?: unknown;
    contexts?: unknown;
    breadcrumbs?: unknown[];
  },
>(event: E): E {
  try {
    if (event.extra) event.extra = trimValue(event.extra);
    if (event.contexts) event.contexts = trimValue(event.contexts);
    if (Array.isArray(event.breadcrumbs))
      event.breadcrumbs = event.breadcrumbs.slice(-30);
  } catch {
    // обрезка не должна ломать отправку события
  }
  return event;
}

export function captureException(err: unknown) {
  try {
    if (!import.meta.env.VITE_SENTRY_DSN) return;
    Sentry.captureException(err);
  } catch {
    // ignore
  }
}
