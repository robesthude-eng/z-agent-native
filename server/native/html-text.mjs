// Readable text from an HTML page for the webfetch tool.
//
// Returning raw markup made the first maxChars of most modern pages nothing but
// <head> boilerplate (preload links, inline scripts, CSS), so the model never
// saw the content it asked for. The extractor is dependency-free and keeps the
// structure that matters for research: headings, paragraphs, lists, table rows,
// code blocks and links.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bull: '•', middot: '·',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×', euro: '€', larr: '←', rarr: '→', shy: '',
  zwj: '', zwnj: '', thinsp: ' ', ensp: ' ', emsp: ' ',
};

export function decodeHtmlEntities(value) {
  // One pass, so "&amp;lt;" stays the literal text "&lt;".
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
      if (!Number.isInteger(code) || code < 9 || code >= 0x110000 || (code >= 0xd800 && code <= 0xdfff)) return '';
      return String.fromCodePoint(code);
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function attr(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? decodeHtmlEntities(match[1] ?? match[2] ?? match[3] ?? '').trim() : '';
}

function absoluteHref(href, baseUrl) {
  if (!href || /^(?:#|javascript:|mailto:|tel:|data:)/i.test(href)) return '';
  try {
    const url = new URL(href, baseUrl || undefined);
    return /^https?:$/.test(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function inlineText(html) {
  return decodeHtmlEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function htmlToReadableText(html, { baseUrl = '', maxLinks = 200 } = {}) {
  let source = String(html || '');
  const title = inlineText((/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(source) || [])[1] || '');
  const descriptionTag = /<meta\b[^>]*\bname\s*=\s*["']?description["']?[^>]*>/i.exec(source)?.[0]
    || /<meta\b[^>]*\bproperty\s*=\s*["']?og:description["']?[^>]*>/i.exec(source)?.[0]
    || '';
  const description = descriptionTag ? attr(descriptionTag, 'content') : '';

  source = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/i, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|select|button)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(?:script|style|link|meta|input|source|track)\b[^>]*>/gi, ' ');

  // Prefer the main content when the page marks it.
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(source)?.[1]
    || /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(source)?.[1];
  if (main && inlineText(main).length >= 200) source = main;

  const codeBlocks = [];
  source = source.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, body) => {
    const code = decodeHtmlEntities(String(body).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')).replace(/^\n+|\s+$/g, '');
    if (!code.trim()) return '\n';
    codeBlocks.push(code);
    return `\n\n\uE000CODE${codeBlocks.length - 1}\uE000\n\n`;
  });

  let links = 0;
  source = source.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, attrs, body) => {
    const text = inlineText(body);
    const href = absoluteHref(attr(`<a ${attrs}>`, 'href'), baseUrl);
    if (!text) return ' ';
    if (!href || links >= maxLinks || href === text) return ` ${text} `;
    links += 1;
    return ` [${text}](${href}) `;
  });

  source = source
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const alt = attr(tag, 'alt');
      return alt ? ` [image: ${alt}] ` : ' ';
    })
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_, level, body) => {
      const text = inlineText(body);
      return text ? `\n\n${'#'.repeat(Number(level))} ${text}\n\n` : '\n\n';
    })
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(?:td|th)\s*>/gi, ' | ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(?:p|div|section|article|main|header|footer|nav|aside|ul|ol|dl|dt|dd|table|thead|tbody|tfoot|tr|blockquote|figure|figcaption|form|fieldset|details|summary|hr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');

  let text = decodeHtmlEntities(source)
    .replace(/[ \t\f\v\r\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n-[ ]?(?=\n|$)/g, '\n')
    .replace(/(?:\s*\|\s*)+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  text = text.replace(/\uE000CODE(\d+)\uE000/g, (_, index) => `\`\`\`\n${codeBlocks[Number(index)] || ''}\n\`\`\``);
  return { title, description, text };
}

export function looksLikeHtml(contentType, body) {
  const type = String(contentType || '').toLowerCase();
  if (type) return /\b(?:text\/html|application\/xhtml\+xml)\b/.test(type);
  return /^\s*(?:<!doctype html|<html[\s>])/i.test(String(body || '').slice(0, 512));
}
