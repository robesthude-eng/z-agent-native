/**
 * Делит Markdown на независимые верхнеуровневые блоки по пустым строкам.
 *
 * Во время стрима меняется только последний блок; остальные можно не
 * разбирать заново. Не делим внутри ``` / ~~~ блоков кода и перед строкой
 * с отступом (продолжение пункта списка или кода). Если в тексте есть
 * ссылочные определения (`[x]: url`) или сноски, блоки зависят друг от
 * друга — тогда возвращаем текст целиком.
 */
export function splitMarkdownBlocks(text: string): string[] {
  if (!text) return [];
  if (/^\s{0,3}\[[^\]]+\]:\s/m.test(text)) return [text];
  const lines = text.split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1];
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = null;
    }
    current.push(line);
    if (fence !== null || line.trim() !== "") continue;
    const nextLine = lines[i + 1];
    if (nextLine === undefined || nextLine.trim() === "") continue;
    if (/^(\s{2,}|\t)/.test(nextLine)) continue;
    // Пустая строка между пунктами одного списка: делим, нумерация
    // сохранится, потому что Markdown берёт номер первого пункта.
    blocks.push(current.join("\n"));
    current = [];
  }
  if (current.length) blocks.push(current.join("\n"));
  return blocks;
}
