/**
 * Russian message catalogue.
 *
 * The UI is Russian-only today, so this is deliberately a plain object rather
 * than a dependency on an i18n runtime. The value it adds now is that strings
 * live in one place and are referenced by a checked key, instead of being
 * hardcoded in components and then patched in the DOM afterwards.
 */
export const messages = {
	"workspace.files": "Файлы",
	"stop.action": "Остановить генерацию",
	"stop.pending": "Останавливаю ответ",
	"stop.pendingShort": "Останавливаю…",
} as const;

export type MessageKey = keyof typeof messages;

/**
 * Russian plural selection (CLDR one/few/many).
 *
 * `count` is used as an absolute value, so negative deltas pick the same form
 * as their positive counterpart.
 */
export function pluralRu(count: number, one: string, few: string, many: string): string {
	const abs = Math.abs(count) % 100;
	const last = abs % 10;
	if (abs > 10 && abs < 20) return many;
	if (last === 1) return one;
	if (last > 1 && last < 5) return few;
	return many;
}
