import fs from 'node:fs';
import path from 'node:path';
import { safeWorkspacePath } from '../security.mjs';
import { mediaMimeType } from './formats.mjs';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function markdownToHtml(markdown) {
  const text = String(markdown || '').replace(/\r\n/g, '\n');
  const codeBlocks = [];
  let masked = text.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = codeBlocks.length;
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
    codeBlocks.push(`<pre><code${cls}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`);
    return `\u0000CODEBLOCK${idx}\u0000`;
  });

  const codeSpans = [];
  masked = masked.replace(/`([^`\n]+)`/g, (_m, code) => {
    const idx = codeSpans.length;
    codeSpans.push(escapeHtml(code));
    return `\u0000CODESPAN${idx}\u0000`;
  });

  const lines = masked.split('\n');
  const html = [];
  let inList = null;

  const closeList = () => {
    if (inList) { html.push(inList === 'ul' ? '</ul>' : '</ol>'); inList = null; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { closeList(); continue; }
    if (line.includes('\u0000CODEBLOCK')) {
      closeList();
      html.push(line.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_m, idx) => codeBlocks[Number(idx)]));
      continue;
    }
    const h = /^(#{1,6})\s+(.+)$/.exec(line);
    if (h) {
      closeList();
      const level = h[1].length;
      html.push(`<h${level}>${formatInline(h[2], codeSpans)}</h${level}>`);
      continue;
    }
    const hr = /^(?:---|\*\*\*|___)\s*$/.exec(line);
    if (hr) {
      closeList();
      html.push('<hr />');
      continue;
    }
    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) {
      closeList();
      html.push(`<blockquote><p>${formatInline(bq[1], codeSpans)}</p></blockquote>`);
      continue;
    }
    const ul = /^[-*+]\s+(.+)$/.exec(line);
    if (ul) {
      if (inList !== 'ul') { closeList(); html.push('<ul>'); inList = 'ul'; }
      html.push(`<li>${formatInline(ul[1], codeSpans)}</li>`);
      continue;
    }
    const ol = /^(\d+)\.\s+(.+)$/.exec(line);
    if (ol) {
      if (inList !== 'ol') { closeList(); html.push('<ol>'); inList = 'ol'; }
      html.push(`<li>${formatInline(ol[2], codeSpans)}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${formatInline(line, codeSpans)}</p>`);
  }
  closeList();
  return html.join('\n');
}

function formatInline(raw, codeSpans) {
  let out = escapeHtml(raw);
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) => `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" />`);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, txt, href) => `<a href="${escapeHtml(href)}">${txt}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  out = out.replace(/\u0000CODESPAN(\d+)\u0000/g, (_m, idx) => `<code>${codeSpans[Number(idx)]}</code>`);
  return out;
}

export function htmlDocument({ title = '', body = '', theme = 'light', css = '', fontSize = 12 } = {}) {
  const isDark = theme === 'dark';
  const bg = isDark ? '#0f172a' : '#ffffff';
  const fg = isDark ? '#f1f5f9' : '#0f172a';
  const cardBg = isDark ? '#1e293b' : '#f8fafc';
  const border = isDark ? '#334155' : '#e2e8f0';
  const primary = isDark ? '#38bdf8' : '#0284c7';
  const codeBg = isDark ? '#0b1220' : '#f1f5f9';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title || 'Document')}</title>
<style>
  :root {
    color-scheme: ${isDark ? 'dark' : 'light'};
  }
  body {
    margin: 0;
    padding: 32px 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: ${fontSize}pt;
    line-height: 1.6;
    color: ${fg};
    background: ${bg};
    box-sizing: border-box;
  }
  .document-container {
    max-width: 800px;
    margin: 0 auto;
  }
  h1, h2, h3, h4, h5, h6 {
    color: ${fg};
    line-height: 1.25;
    margin-top: 1.5em;
    margin-bottom: 0.5em;
  }
  h1 { font-size: 2em; border-bottom: 1px solid ${border}; padding-bottom: 0.3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid ${border}; padding-bottom: 0.3em; }
  p, ul, ol, blockquote, pre, table {
    margin-top: 0;
    margin-bottom: 1em;
  }
  a { color: ${primary}; text-decoration: none; }
  a:hover { text-decoration: underline; }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    font-size: 0.9em;
    background: ${codeBg};
    padding: 0.2em 0.4em;
    border-radius: 4px;
  }
  pre {
    background: ${codeBg};
    padding: 16px;
    border-radius: 8px;
    overflow-x: auto;
    border: 1px solid ${border};
  }
  pre code {
    background: transparent;
    padding: 0;
  }
  blockquote {
    border-left: 4px solid ${primary};
    padding-left: 16px;
    color: ${isDark ? '#94a3b8' : '#64748b'};
    margin-left: 0;
  }
  hr {
    border: 0;
    height: 1px;
    background: ${border};
    margin: 24px 0;
  }
  img {
    max-width: 100%;
    height: auto;
    border-radius: 6px;
  }
  ${css || ''}
</style>
</head>
<body>
<div class="document-container">
${body}
</div>
</body>
</html>`;
}

export function inlineWorkspaceAssets(html, root, { maxTotalBytes = 1_200_000 } = {}) {
  let totalInlined = 0;
  return html.replace(/<img\s+([^>]*?)src=["']([^"']+)["']([^>]*?)>/gi, (match, prefix, src, suffix) => {
    if (src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://')) return match;
    try {
      const abs = safeWorkspacePath(root, src);
      if (!fs.existsSync(abs)) return match;
      const stat = fs.statSync(abs);
      if (totalInlined + stat.size > maxTotalBytes) return match;
      const mime = mediaMimeType(src);
      const data = fs.readFileSync(abs).toString('base64');
      totalInlined += stat.size;
      return `<img ${prefix}src="data:${mime};base64,${data}"${suffix}>`;
    } catch {
      return match;
    }
  });
}

export function winAnsiCode(char) {
  const code = char.charCodeAt(0);
  if (code < 128) return code;
  return null;
}

export function unsupportedPdfCharacters(text) {
  const unsupported = new Set();
  for (const ch of String(text || '')) {
    if (ch.charCodeAt(0) >= 128) unsupported.add(ch);
  }
  return [...unsupported];
}

export function measureHelvetica(text, fontSize) {
  return String(text || '').length * fontSize * 0.55;
}

export function wrapPlainText(text, { fontSize = 11, maxWidth = 480 } = {}) {
  const lines = [];
  for (const rawLine of String(text || '').split('\n')) {
    if (!rawLine) { lines.push(''); continue; }
    let current = '';
    for (const word of rawLine.split(' ')) {
      const candidate = current ? `${current} ${word}` : word;
      if (measureHelvetica(candidate, fontSize) <= maxWidth) {
        current = candidate;
      } else {
        if (current) lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

export function pdfFromText(text, { title = '', fontSize = 11, pageSize = 'a4', margin = 56, lineHeight = 1.45 } = {}) {
  const width = pageSize === 'letter' ? 612 : 595.28;
  const height = pageSize === 'letter' ? 792 : 841.89;
  const maxWidth = width - margin * 2;
  const lines = wrapPlainText(text, { fontSize, maxWidth });
  const leading = fontSize * lineHeight;
  const linesPerPage = Math.floor((height - margin * 2 - (title ? 40 : 0)) / leading);

  const pages = [];
  for (let i = 0; i < lines.length; i += linesPerPage) {
    pages.push(lines.slice(i, i + linesPerPage));
  }
  if (pages.length === 0) pages.push(['']);

  const objects = [];
  const addObject = (content) => {
    objects.push(content);
    return objects.length;
  };

  const fontObj = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageObjectIds = [];

  for (let i = 0; i < pages.length; i++) {
    const pageLines = pages[i];
    const streamContent = [
      'BT',
      `/F1 ${fontSize} Tf`,
      `${margin} ${height - margin - fontSize} Td`,
      `${leading} TL`,
    ];
    if (title && i === 0) {
      streamContent.push(`/F1 ${fontSize + 4} Tf`);
      streamContent.push(`(${title.replace(/[\(\)\\]/g, '\\$&')}) Tj`);
      streamContent.push('T*');
      streamContent.push(`/F1 ${fontSize} Tf`);
    }
    for (const line of pageLines) {
      const escaped = line.replace(/[\(\)\\]/g, '\\$&');
      streamContent.push(`(${escaped}) Tj`);
      streamContent.push('T*');
    }
    streamContent.push('ET');
    const streamBytes = streamContent.join('\n');
    const contentsObj = addObject(`<< /Length ${streamBytes.length} >>\nstream\n${streamBytes}\nendstream`);
    const pageObj = addObject(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Contents ${contentsObj} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`);
    pageObjectIds.push(pageObj);
  }

  const pagesObj = `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageObjectIds.length} >>`;
  objects[1] = pagesObj; // Pages is object 2
  const catalogObj = addObject('<< /Type /Catalog /Pages 2 0 R >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogObj} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(pdf, 'latin1');
}
