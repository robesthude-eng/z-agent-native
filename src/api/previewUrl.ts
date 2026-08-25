import { useEffect, useState } from "react";
import { workspacePreviewUrl } from "@/components/workspace/fileDecisions";

/**
 * Адрес, по которому iframe превью грузит страницу из воркспейса.
 *
 * Превью открывается без `allow-same-origin`, то есть у документа непрозрачный
 * origin. Запросы из такого документа браузер считает межсайтовыми и не шлёт
 * с ними куку SameSite=Lax. Сам документ ещё открывается — переход
 * инициирует само приложение, — а вот соседние style.css и script.js уже
 * уходят без авторизации и получают 404: страница выглядит сломанной.
 *
 * Поэтому у сервера берётся маркер, который живёт в пути: относительные
 * ссылки внутри страницы наследуют его сами, в отличие от query-параметра.
 *
 * Если маркер получить не удалось, остаётся прежний адрес с доступом по
 * cookie: однофайловая страница на нём откроется, и превью не пропадёт целиком.
 */

const BASE_SHAPE = /^\/api\/preview\/[a-f0-9]{64}\/~\/$/;

function encodeRelative(filePath: string): string {
  return filePath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

export async function fetchPreviewBase(
  sessionId: string,
): Promise<string | null> {
  try {
    const response = await fetch(
      `/api/workspace/preview-token?sessionId=${encodeURIComponent(sessionId)}`,
      { credentials: "same-origin" },
    );
    if (!response.ok) return null;
    const data = (await response.json()) as { base?: unknown };
    const base = typeof data.base === "string" ? data.base : "";
    // Адрес из ответа попадает в src фрейма, поэтому проверяем форму, а не
    // доверяем строке целиком.
    return BASE_SHAPE.test(base) ? base : null;
  } catch {
    return null;
  }
}

export function usePreviewUrl(
  sessionId: string,
  filePath: string,
  enabled = true,
): string {
  const [base, setBase] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !sessionId) {
      setBase(null);
      return;
    }
    let alive = true;
    void fetchPreviewBase(sessionId).then((value) => {
      if (alive) setBase(value);
    });
    return () => {
      alive = false;
    };
  }, [enabled, sessionId]);

  if (!sessionId || !filePath) return "";
  return base
    ? `${base}${encodeRelative(filePath)}`
    : workspacePreviewUrl(filePath, sessionId);
}
