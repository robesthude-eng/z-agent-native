/**
 * Лёгкий фронтенд-логгер вместо прямых console.* вызовов.
 * debug/warn активны только в dev-сборке (import.meta.env.DEV);
 * error остаётся и в проде — важные инварианты, плюс Sentry уже подключён.
 */
const isDev = import.meta.env.DEV;

export const log = {
  debug: (...args: unknown[]): void => {
    if (isDev) console.debug(...args);
  },
  warn: (...args: unknown[]): void => {
    if (isDev) console.warn(...args);
  },
  error: (...args: unknown[]): void => {
    console.error(...args);
  },
};
