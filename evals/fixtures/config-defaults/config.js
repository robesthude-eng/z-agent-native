export function timeoutMs(env = process.env) {
  const parsed = Number.parseInt(env.APP_TIMEOUT_MS || '', 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
