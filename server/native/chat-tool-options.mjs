export function normalizeChatToolOptions(value) {
  if (value == null) return { webSearch: true };
  if (typeof value !== 'object' || Array.isArray(value) || (value.webSearch !== undefined && typeof value.webSearch !== 'boolean')) {
    throw Object.assign(new Error('toolOptions.webSearch must be a boolean'), { statusCode: 400 });
  }
  return { webSearch: value.webSearch !== false };
}
export function filterChatTools(definitions, options) {
  return options?.webSearch === false ? definitions.filter((tool) => tool.name !== 'websearch') : definitions;
}
export function assertChatToolAllowed(name, options) {
  if (String(name).toLowerCase() === 'websearch' && options?.webSearch === false) throw new Error('Веб-поиск выключен пользователем для этого запроса.');
}
