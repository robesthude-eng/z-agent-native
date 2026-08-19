import { type MessageKey, messages, pluralRu } from "./ru";

export type { MessageKey };
export { pluralRu };

/**
 * Look up a UI string. The key is checked at compile time, so a typo is a build
 * error rather than a blank label.
 */
export function t(key: MessageKey): string {
	return messages[key];
}

/**
 * "изменён 1 файл" / "изменено 2 файла" / "изменено 5 файлов".
 *
 * Replaces the English `count === 1 ? "file" : "files"` branch, which produced
 * wrong forms for every Russian number ending in 2-4.
 */
export function changedFilesLabel(count: number): string {
	const verb = pluralRu(count, "изменён", "изменено", "изменено");
	const noun = pluralRu(count, "файл", "файла", "файлов");
	return `${verb} ${count} ${noun}`;
}
