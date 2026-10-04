const key = (owner: string, session: string | null) =>
  `z-agent:chat-tools:${owner}:${session || "draft"}`;
const memory = new Map<string, boolean>();
export function webSearchPreference(
  owner: string,
  session: string | null,
): boolean {
  const stored = memory.get(key(owner, session));
  if (stored !== undefined) return stored;
  try {
    return localStorage.getItem(key(owner, session)) !== "off";
  } catch {
    return true;
  }
}
export function setWebSearchPreference(
  owner: string,
  session: string | null,
  enabled: boolean,
) {
  memory.set(key(owner, session), enabled);
  try {
    localStorage.setItem(key(owner, session), enabled ? "on" : "off");
  } catch {
    /* Retain the restriction in memory when browser storage is unavailable. */
  }
}
export function transferChatTools(
  owner: string,
  from: string | null,
  to: string,
) {
  setWebSearchPreference(owner, to, webSearchPreference(owner, from));
}
