const key = (owner: string, session: string | null) =>
  `z-agent:chat-tools:${owner}:${session || "draft"}`;
const memory = new Map<string, boolean>();
const bashKey = (owner: string, session: string | null) =>
  `z-agent:chat-tools:bash-first:${owner}:${session || "draft"}`;
/**
 * Режим «Bash-first»: агент делает разведку и проверки командами shell вместо
 * read/grep/glob/run_tests. По умолчанию выключен и включается явно для чата.
 */
export function bashFirstPreference(
  owner: string,
  session: string | null,
): boolean {
  const stored = memory.get(bashKey(owner, session));
  if (stored !== undefined) return stored;
  try {
    return localStorage.getItem(bashKey(owner, session)) === "on";
  } catch {
    return false;
  }
}
export function setBashFirstPreference(
  owner: string,
  session: string | null,
  enabled: boolean,
) {
  memory.set(bashKey(owner, session), enabled);
  try {
    localStorage.setItem(bashKey(owner, session), enabled ? "on" : "off");
  } catch {
    /* Keep the choice in memory when browser storage is unavailable. */
  }
}
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
  setBashFirstPreference(owner, to, bashFirstPreference(owner, from));
}
