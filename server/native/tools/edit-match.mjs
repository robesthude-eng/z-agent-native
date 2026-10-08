// Tolerant text matching for the `edit` tool.
//
// The replacer cascade (exact → line-trimmed → block anchors → whitespace →
// indentation → escapes → trimmed boundary → context-aware) is ported from
// opencode (https://github.com/sst/opencode, packages/opencode/src/tool/edit.ts),
// MIT License, Copyright (c) 2025 opencode. Adapted to plain ESM and extended
// with strategy names so the tool can tell the model how the match was found.

const SIMILARITY_THRESHOLD = 0.65;

function levenshtein(a, b) {
  if (a === '' || b === '') return Math.max(a.length, b.length);
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

function lineOffset(lines, upTo) {
  let offset = 0;
  for (let k = 0; k < upTo; k++) offset += lines[k].length + 1;
  return offset;
}

function blockText(content, lines, startLine, endLine) {
  const start = lineOffset(lines, startLine);
  let end = start;
  for (let k = startLine; k <= endLine; k++) {
    end += lines[k].length;
    if (k < endLine) end += 1;
  }
  return content.substring(start, end);
}

function* simple(_content, find) {
  yield find;
}

function* lineTrimmed(content, find) {
  const originalLines = content.split('\n');
  const searchLines = find.split('\n');
  if (searchLines[searchLines.length - 1] === '') searchLines.pop();
  if (!searchLines.length) return;
  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }
    if (matches) yield blockText(content, originalLines, i, i + searchLines.length - 1);
  }
}

function middleSimilarity(originalLines, searchLines, startLine, endLine) {
  const searchBlockSize = searchLines.length;
  const actualBlockSize = endLine - startLine + 1;
  const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
  if (linesToCheck <= 0) return 1;
  let similarity = 0;
  for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
    const originalLine = originalLines[startLine + j].trim();
    const searchLine = searchLines[j].trim();
    const maxLen = Math.max(originalLine.length, searchLine.length);
    if (maxLen === 0) continue;
    similarity += (1 - levenshtein(originalLine, searchLine) / maxLen) / linesToCheck;
  }
  return similarity;
}

function* blockAnchor(content, find) {
  const originalLines = content.split('\n');
  const searchLines = find.split('\n');
  if (searchLines.length < 3) return;
  if (searchLines[searchLines.length - 1] === '') searchLines.pop();
  if (searchLines.length < 3) return;
  const first = searchLines[0].trim();
  const last = searchLines[searchLines.length - 1].trim();
  const size = searchLines.length;
  const maxDelta = Math.max(1, Math.floor(size * 0.25));
  const candidates = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== first) continue;
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === last) {
        if (Math.abs(j - i + 1 - size) <= maxDelta) candidates.push({ startLine: i, endLine: j });
        break;
      }
    }
  }
  if (!candidates.length) return;
  let best = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = middleSimilarity(originalLines, searchLines, candidate.startLine, candidate.endLine);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  if (best && bestScore >= SIMILARITY_THRESHOLD) yield blockText(content, originalLines, best.startLine, best.endLine);
}

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function* whitespaceNormalized(content, find) {
  const normalizedFind = normalizeWhitespace(find);
  if (!normalizedFind) return;
  const lines = content.split('\n');
  for (const line of lines) {
    const normalizedLine = normalizeWhitespace(line);
    if (normalizedLine === normalizedFind) {
      yield line;
    } else if (normalizedLine.includes(normalizedFind)) {
      const words = find.trim().split(/\s+/);
      const pattern = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
      try {
        const match = line.match(new RegExp(pattern));
        if (match) yield match[0];
      } catch {
        // invalid pattern: skip this line
      }
    }
  }
  const findLines = find.split('\n');
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length).join('\n');
      if (normalizeWhitespace(block) === normalizedFind) yield block;
    }
  }
}

function removeIndentation(text) {
  const lines = text.split('\n');
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (!nonEmpty.length) return text;
  const minIndent = Math.min(...nonEmpty.map((line) => line.match(/^(\s*)/)[1].length));
  return lines.map((line) => (line.trim().length === 0 ? line : line.slice(minIndent))).join('\n');
}

function* indentationFlexible(content, find) {
  const normalizedFind = removeIndentation(find);
  const contentLines = content.split('\n');
  const findLines = find.split('\n');
  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join('\n');
    if (removeIndentation(block) === normalizedFind) yield block;
  }
}

const ESCAPES = { n: '\n', t: '\t', r: '\r', "'": "'", '"': '"', '`': '`', '\\': '\\', '\n': '\n', $: '$' };

function unescapeString(str) {
  return str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (_match, ch) => ESCAPES[ch]);
}

function* escapeNormalized(content, find) {
  const unescapedFind = unescapeString(find);
  if (unescapedFind !== find && content.includes(unescapedFind)) yield unescapedFind;
  const lines = content.split('\n');
  const findLines = unescapedFind.split('\n');
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n');
    if (unescapeString(block) === unescapedFind) yield block;
  }
}

function* trimmedBoundary(content, find) {
  const trimmedFind = find.trim();
  if (!trimmedFind || trimmedFind === find) return;
  if (content.includes(trimmedFind)) yield trimmedFind;
  const lines = content.split('\n');
  const findLines = find.split('\n');
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n');
    if (block.trim() === trimmedFind) yield block;
  }
}

function* contextAware(content, find) {
  const findLines = find.split('\n');
  if (findLines.length < 3) return;
  if (findLines[findLines.length - 1] === '') findLines.pop();
  if (findLines.length < 3) return;
  const contentLines = content.split('\n');
  const first = findLines[0].trim();
  const last = findLines[findLines.length - 1].trim();
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== first) continue;
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() !== last) continue;
      const blockLines = contentLines.slice(i, j + 1);
      if (blockLines.length === findLines.length) {
        let matching = 0;
        let total = 0;
        for (let k = 1; k < blockLines.length - 1; k++) {
          const a = blockLines[k].trim();
          const b = findLines[k].trim();
          if (a.length > 0 || b.length > 0) {
            total++;
            if (a === b) matching++;
          }
        }
        if (total === 0 || matching / total >= 0.5) {
          yield blockLines.join('\n');
          break;
        }
      }
      break;
    }
  }
}

const REPLACERS = [
  ['exact', simple],
  ['line-trimmed', lineTrimmed],
  ['block-anchor', blockAnchor],
  ['whitespace-normalized', whitespaceNormalized],
  ['indentation-flexible', indentationFlexible],
  ['escape-normalized', escapeNormalized],
  ['trimmed-boundary', trimmedBoundary],
  ['context-aware', contextAware],
];

function countOccurrences(content, search) {
  let count = 0;
  let from = 0;
  while (true) {
    const index = content.indexOf(search, from);
    if (index === -1) return count;
    count++;
    from = index + search.length;
  }
}

// A fuzzy match that is much larger than what the model wrote is almost
// certainly the wrong block; refuse it instead of rewriting a big region.
function isDisproportionate(search, oldText) {
  const oldLines = oldText.split('\n').length;
  const searchLines = search.split('\n').length;
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
  if (oldLines === 1) return false;
  return search.trim().length > Math.max(oldText.trim().length + 500, oldText.trim().length * 4);
}

/**
 * Locates `oldText` in `content`, tolerating whitespace/indentation/escape
 * differences. Returns `{ search, strategy, occurrences, index }` where
 * `search` is the exact span of `content` to replace. Throws with an
 * actionable message when nothing matches or the match is ambiguous.
 */
export function findEditMatch(content, oldText, { all = false } = {}) {
  if (oldText === '') throw new Error('oldText must not be empty');
  let ambiguous = false;
  for (const [strategy, replacer] of REPLACERS) {
    for (const search of replacer(content, oldText)) {
      if (!search) continue;
      const index = content.indexOf(search);
      if (index === -1) continue;
      if (strategy !== 'exact' && isDisproportionate(search, oldText)) {
        throw new Error(
          'Refusing replacement: the tolerant match is much larger than oldText. Re-read the file and pass the full exact oldText for the intended region.',
        );
      }
      const occurrences = countOccurrences(content, search);
      if (all) return { search, strategy, occurrences, index };
      if (occurrences === 1) return { search, strategy, occurrences, index };
      ambiguous = true;
    }
  }
  if (ambiguous) {
    throw new Error(
      'oldText matches several places. Include more surrounding lines to make it unique, or pass all=true to replace every occurrence.',
    );
  }
  throw new Error(
    'oldText was not found in file. It must match the file text; re-read the relevant lines (read with offset/limit) and copy them exactly, including indentation.',
  );
}
