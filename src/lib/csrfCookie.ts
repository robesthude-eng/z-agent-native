/**
 * Double-submit CSRF cookie. After Secure cookies moved to the `__Host-`
 * prefix, a leftover `z_agent_csrf` from the previous deploy can still sit
 * next to `__Host-z_agent_csrf`. A naive `(?:__Host-)?` regex matches the
 * unprefixed name first and the SPA then echoes the stale token → 403.
 */
export function readCsrfCookie(
  cookie = typeof document === "undefined" ? "" : document.cookie,
): string {
  const map = new Map<string, string>();
  for (const part of String(cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    const raw = part.slice(i + 1).trim();
    if (!key) continue;
    try {
      map.set(key, decodeURIComponent(raw));
    } catch {
      map.set(key, raw);
    }
  }
  return map.get("__Host-z_agent_csrf") || map.get("z_agent_csrf") || "";
}

export function csrfHeaders(
  cookie = typeof document === "undefined" ? "" : document.cookie,
): Record<string, string> {
  const csrf = readCsrfCookie(cookie);
  return csrf ? { "x-csrf-token": csrf } : {};
}
