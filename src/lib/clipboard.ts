/**
 * Копирование в буфер обмена с fallback для не-HTTPS контекстов.
 *
 * navigator.clipboard существует только в secure context (HTTPS или
 * localhost). На VDS по plain HTTP используем скрытый textarea +
 * document.execCommand("copy"), но с лимитом размера: именно синхронное
 * копирование огромных полотен кода вешало вкладку (причина удаления
 * старого fallback в релизе 3). Legacy-путь включается только когда
 * современного API нет или он упал.
 */

const EXEC_COPY_LIMIT = 200_000;

export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Например, документ не в фокусе — пробуем legacy-путь.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (!text || text.length > EXEC_COPY_LIMIT) return false;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
