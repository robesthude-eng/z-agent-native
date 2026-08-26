import fs from 'node:fs';
import path from 'node:path';
import { safeWorkspacePath } from '../security.mjs';
import { mediaMimeType, clampNumber } from './formats.mjs';

export function escapeHtml(value) {
  return String(value ?? '')
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;');
}

function inlineMarkdown(text) {
  let out = escapeHtml(text);
  const codeSpans = [];
  out = out.replace(/`([^`]+)`/g, (_match, code) => {
    codeSpans.push(code);
    return `\u0000CODE${codeSpans.length - 1}\u0000`;
  });
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => `<img alt="${alt}" src="${src}" />`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, href) => `<a href="${href}">${label}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_m, index) => `<code>${codeSpans[Number(index)]}</code>`);
  return out;
}

export function markdownToHtml(markdown) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let paragraph = [];
  let listType = '';
  let inCode = false;
  let codeLang = '';
  let code = [];
  let table = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${inlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = '';
  };
  const flushTable = () => {
    if (!table) return;
    const head = table.head.map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('');
    const body = table.rows.map((row) => `<tr>${row.map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('')}</tr>`).join('');
    html.push(`<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`);
    table = null;
  };
  const flushAll = () => { flushParagraph(); flushList(); flushTable(); };
  const splitRow = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());

  for (const line of lines) {
    const fence = /^\s*```+\s*([A-Za-z0-9_+-]*)\s*$/.exec(line);
    if (fence) {
      if (inCode) {
        html.push(`<pre><code${codeLang ? ` class="language-${escapeHtml(codeLang)}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`);
        inCode = false;
        code = [];
        codeLang = '';
      } else {
        flushAll();
        inCode = true;
        codeLang = fence[1] || '';
      }
      continue;
    }
    if (inCode) { code.push(line); continue; }

    if (!line.trim()) { flushAll(); continue; }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); html.push('<hr />'); continue; }

    const heading = /^\s*(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2].trim())}</h${level}>`);
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flushAll();
      html.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph();
      flushList();
      const cells = splitRow(line);
      if (!table) { table = { head: cells, rows: [] }; continue; }
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
      table.rows.push(cells);
      continue;
    }
    flushTable();

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const wanted = bullet ? 'ul' : 'ol';
      if (listType && listType !== wanted) flushList();
      if (!listType) { html.push(`<${wanted}>`); listType = wanted; }
      const item = (bullet ? bullet[1] : ordered[1]).trim();
      const todo = /^\[([ xX])\]\s+(.*)$/.exec(item);
      if (todo) html.push(`<li class="task"><input type="checkbox" disabled${todo[1].toLowerCase() === 'x' ? ' checked' : ''} /> ${inlineMarkdown(todo[2])}</li>`);
      else html.push(`<li>${inlineMarkdown(item)}</li>`);
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  if (inCode && code.length) html.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushAll();
  return html.join('\n');
}

const DOCUMENT_THEMES = {
  light: { bg: '#ffffff', fg: '#101014', muted: '#5b5b66', accent: '#2f6feb', border: '#e2e2e8', code: '#f5f5f7' },
  dark: { bg: '#0f1013', fg: '#f2f2f5', muted: '#a6a6b3', accent: '#7aa2ff', border: '#2a2b33', code: '#1a1b21' },
};

export function htmlDocument({ title = '', body = '', theme = 'light', css = '', fontSize = 12 } = {}) {
  const palette = DOCUMENT_THEMES[String(theme).toLowerCase()] || DOCUMENT_THEMES.light;
  const size = clampNumber(fontSize, 7, 32, 12);
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title || 'Document')}</title>
<style>
  @page { margin: 18mm 16mm; }
  :root { color-scheme: ${theme === 'dark' ? 'dark' : 'light'}; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0 4mm;
    background: ${palette.bg};
    color: ${palette.fg};
    font-family: "Inter", "Noto Sans", "DejaVu Sans", "Liberation Sans", -apple-system, system-ui, "Segoe UI", Arial, sans-serif;
    font-size: ${size}pt;
    line-height: 1.55;
  }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.6em; page-break-after: avoid; }
  h1 { font-size: 1.9em; } h2 { font-size: 1.5em; } h3 { font-size: 1.25em; }
  p { margin: 0 0 0.85em; }
  a { color: ${palette.accent}; }
  ul, ol { margin: 0 0 0.9em 1.3em; padding: 0; }
  li { margin: 0.2em 0; }
  li.task { list-style: none; margin-left: -1.2em; }
  blockquote { margin: 0 0 1em; padding: 0.4em 1em; border-left: 3px solid ${palette.border}; color: ${palette.muted}; }
  hr { border: none; border-top: 1px solid ${palette.border}; margin: 1.6em 0; }
  code { font-family: "JetBrains Mono", "DejaVu Sans Mono", "Liberation Mono", ui-monospace, monospace; font-size: 0.92em; background: ${palette.code}; padding: 0.1em 0.35em; border-radius: 4px; }
  pre { background: ${palette.code}; border: 1px solid ${palette.border}; border-radius: 8px; padding: 0.9em 1em; overflow-x: auto; page-break-inside: avoid; }
  pre code { background: none; padding: 0; }
  img { max-width: 100%; height: auto; page-break-inside: avoid; }
  table { border-collapse: collapse; width: 100%; margin: 0 0 1.1em; page-break-inside: avoid; }
  th, td { border: 1px solid ${palette.border}; padding: 0.45em 0.6em; text-align: left; vertical-align: top; }
  th { background: ${palette.code}; font-weight: 600; }
${css ? `  /* caller styles */\n${css}\n` : ''}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

export function inlineWorkspaceAssets(html, root, { maxTotalBytes = 1_200_000 } = {}) {
  let budget = maxTotalBytes;
  const skipped = [];
  const replaced = String(html).replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/g, (match, before, src, after) => {
    if (/^(data:|https?:|file:)/i.test(src)) return match;
    let resolved;
    try { resolved = safeWorkspacePath(root, decodeURIComponent(src), { allowMissing: false }); }
    catch { skipped.push(src); return match; }
    let bytes;
    try { bytes = fs.readFileSync(resolved); }
    catch { skipped.push(src); return match; }
    if (bytes.length > budget) { skipped.push(src); return match; }
    budget -= bytes.length;
    return `${before}data:${mediaMimeType(resolved)};base64,${bytes.toString('base64')}${after}`;
  });
  return { html: replaced, skipped };
}

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792], legal: [612, 1008] };

const HELVETICA_WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

const WINANSI_EXTRA = new Map(Object.entries({
  '\u20ac': 128, '\u201a': 130, '\u0192': 131, '\u201e': 132, '\u2026': 133, '\u2020': 134, '\u2021': 135,
  '\u02c6': 136, '\u2030': 137, '\u0160': 138, '\u2039': 139, '\u0152': 140, '\u017d': 142, '\u2018': 145,
  '\u2019': 146, '\u201c': 147, '\u201d': 148, '\u2022': 149, '\u2013': 150, '\u2014': 151, '\u02dc': 152,
  '\u2122': 153, '\u0161': 154, '\u203a': 155, '\u0153': 156, '\u017e': 158, '\u0178': 159,
}));

export function winAnsiCode(char) {
  const code = char.codePointAt(0);
  if (code === 9) return 32;
  if (code >= 32 && code <= 126) return code;
  if (code >= 160 && code <= 255) return code;
  const extra = WINANSI_EXTRA.get(char);
  return extra === undefined ? null : extra;
}

export function unsupportedPdfCharacters(text) {
  const missing = new Set();
  for (const char of String(text ?? '')) {
    if (char === '\n' || char === '\r') continue;
    if (winAnsiCode(char) === null) missing.add(char);
  }
  return [...missing];
}

function pdfLiteral(text) {
  const bytes = [];
  for (const char of String(text ?? '')) {
    const code = winAnsiCode(char);
    if (code === null) continue;
    if (code === 0x28 || code === 0x29 || code === 0x5c) bytes.push(0x5c);
    bytes.push(code);
  }
  return Buffer.from(bytes);
}

export function measureHelvetica(text, fontSize) {
  let total = 0;
  for (const char of String(text ?? '')) {
    const code = char.codePointAt(0);
    total += code >= 32 && code <= 126 ? HELVETICA_WIDTHS[code - 32] : 556;
  }
  return (total / 1000) * fontSize;
}

export function wrapPlainText(text, { fontSize = 11, maxWidth = 480 } = {}) {
  const output = [];
  for (const rawLine of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.replace(/\t/g, '    ');
    if (!line.trim()) { output.push(''); continue; }
    let current = '';
    for (const word of line.split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureHelvetica(candidate, fontSize) <= maxWidth || !current) {
        if (measureHelvetica(candidate, fontSize) > maxWidth && !current) {
          let chunk = '';
          for (const char of candidate) {
            if (measureHelvetica(chunk + char, fontSize) > maxWidth && chunk) { output.push(chunk); chunk = char; }
            else chunk += char;
          }
          current = chunk;
          continue;
        }
        current = candidate;
        continue;
      }
      output.push(current);
      current = word;
    }
    if (current) output.push(current);
  }
  return output;
}

export function pdfFromText(text, { title = '', fontSize = 11, pageSize = 'a4', margin = 56, lineHeight = 1.45 } = {}) {
  const missing = unsupportedPdfCharacters(`${text}\n${title}`);
  if (missing.length) {
    throw Object.assign(
      new Error(`The built-in PDF writer only covers Latin-1 text and cannot encode: ${missing.slice(0, 8).join(' ')}. Render through Chromium (browser service or a local chromium binary) for full Unicode support.`),
      { code: 'PDF_UNSUPPORTED_CHARSET' },
    );
  }
  const [pageWidth, pageHeight] = PAGE_SIZES[String(pageSize).toLowerCase()] || PAGE_SIZES.a4;
  const size = clampNumber(fontSize, 6, 40, 11);
  const gutter = clampNumber(margin, 18, 160, 56);
  const leading = Math.round(size * clampNumber(lineHeight, 1, 3, 1.45) * 100) / 100;
  const lines = wrapPlainText(text, { fontSize: size, maxWidth: pageWidth - gutter * 2 });
  const perPage = Math.max(1, Math.floor((pageHeight - gutter * 2) / leading));
  const pages = [];
  for (let index = 0; index < Math.max(lines.length, 1); index += perPage) pages.push(lines.slice(index, index + perPage));

  const objects = [];
  const push = (buffer) => { objects.push(buffer); return objects.length; };
  const catalog = push(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>', 'latin1'));
  const pagesObj = push(Buffer.alloc(0));
  const fontObj = push(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>', 'latin1'));
  const kids = [];
  for (const pageLines of pages) {
    const streamParts = [Buffer.from(`BT\n/F1 ${size} Tf\n${leading} TL\n1 0 0 1 ${gutter.toFixed(2)} ${(pageHeight - gutter - size).toFixed(2)} Tm\n`, 'latin1')];
    for (const line of pageLines) {
      streamParts.push(Buffer.from('(', 'latin1'), pdfLiteral(line), Buffer.from(') Tj T*\n', 'latin1'));
    }
    streamParts.push(Buffer.from('ET', 'latin1'));
    const stream = Buffer.concat(streamParts);
    const contentObj = push(Buffer.concat([
      Buffer.from(`<< /Length ${stream.length} >>\nstream\n`, 'latin1'),
      stream,
      Buffer.from('\nendstream', 'latin1'),
    ]));
    const pageObj = push(Buffer.from(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}] /Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`, 'latin1'));
    kids.push(`${pageObj} 0 R`);
  }
  objects[pagesObj - 1] = Buffer.from(`<< /Type /Pages /Count ${kids.length} /Kids [${kids.join(' ')}] >>`, 'latin1');
  const infoObj = push(Buffer.concat([
    Buffer.from('<< /Title (', 'latin1'),
    pdfLiteral(title || 'Document'),
    Buffer.from(`) /Producer (Z Agent) /CreationDate (D:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z) >>`, 'latin1'),
  ]));

  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  let offset = chunks[0].length;
  const offsets = [];
  objects.forEach((body, index) => {
    const entry = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`, 'latin1'), body, Buffer.from('\nendobj\n', 'latin1')]);
    offsets.push(offset);
    offset += entry.length;
    chunks.push(entry);
  });
  const xrefStart = offset;
  const xref = [`xref\n0 ${objects.length + 1}\n`, '0000000000 65535 f \n'];
  for (const value of offsets) xref.push(`${String(value).padStart(10, '0')} 00000 n \n`);
  chunks.push(Buffer.from(xref.join(''), 'latin1'));
  chunks.push(Buffer.from(`trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(chunks);
}
