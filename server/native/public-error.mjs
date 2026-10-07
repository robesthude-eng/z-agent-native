// Превращает неожиданную ошибку в безопасный для клиента ответ.
//
// Без statusCode любая ошибка файловой системы раньше превращалась в 500 с
// текстом Node вида "ENOENT: no such file or directory, lstat '/work/...'":
// отсутствующий файл выглядел как сбой сервера, а в ответ попадал внутренний
// абсолютный путь контейнера.
const FS_STATUS = {
  ENOENT: [404, 'Файл или папка не найдены'],
  ENOTDIR: [400, 'Путь указывает не на папку'],
  EISDIR: [400, 'Путь указывает на папку, а не на файл'],
  EACCES: [403, 'Нет доступа к этому пути'],
  EPERM: [403, 'Нет доступа к этому пути'],
};

export function redactPaths(message) {
  return String(message || '').replace(/(['"`])\/[^'"`\n]*\1/g, '$1<path>$1');
}

export function publicErrorInfo(err, { requestId = '' } = {}) {
  const explicit = Number(err?.statusCode);
  if (explicit) return { status: explicit, message: err?.message || 'Internal Server Error', code: err?.code || undefined };
  if (err?.name === 'AbortError') return { status: 499, message: err?.message || 'Aborted', code: err?.code || undefined };
  const mapped = FS_STATUS[err?.code];
  if (mapped) return { status: mapped[0], message: mapped[1], code: err.code };
  // With a request ID the internal message is withheld from the client; the
  // full error is in the server log under the same ID.
  if (requestId) return { status: 500, message: `Внутренняя ошибка сервера. Код запроса: ${requestId}`, code: undefined, requestId };
  return { status: 500, message: redactPaths(err?.message) || 'Internal Server Error', code: err?.code || undefined };
}
