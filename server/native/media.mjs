import fs from 'node:fs';
import path from 'node:path';
import { safeWorkspacePath } from './security.mjs';
import { syncSandboxOwnership } from './sandbox.mjs';

// Multimedia generation and rendering for the agent runtime.
//
// Two very different execution paths live behind these tools and the split is
// deliberate:
//   * deterministic rendering (ffmpeg / ffprobe / headless Chromium) runs in
//     the same isolated place as `bash`, through the caller supplied `run`
//     callback, so a model generated filter graph cannot escape the session
//     sandbox or the networkless executor;
//   * model backed generation (image / speech) never spawns a process. It
//     reuses the configured provider channel exactly like a chat completion,
//     so provider keys stay in the trusted runtime and never reach a shell.
//
// Everything in this file that builds a command returns an argv array. Nothing
// interpolates model text into a shell string except `shellCommand`, which
// quotes every element.

export const IMAGE_FORMATS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff', 'avif'];
export const VIDEO_FORMATS = ['mp4', 'webm', 'mkv', 'mov', 'gif'];
export const AUDIO_FORMATS = ['mp3', 'wav', 'ogg', 'opus', 'm4a', 'flac', 'aac'];
export const DOCUMENT_FORMATS = ['pdf', 'html', 'png', 'jpg', 'txt', 'md'];

const MEDIA_TYPES = {
  png: { kind: 'image', mime: 'image/png' },
  jpg: { kind: 'image', mime: 'image/jpeg' },
  jpeg: { kind: 'image', mime: 'image/jpeg' },
  webp: { kind: 'image', mime: 'image/webp' },
  gif: { kind: 'image', mime: 'image/gif' },
  bmp: { kind: 'image', mime: 'image/bmp' },
  tiff: { kind: 'image', mime: 'image/tiff' },
  avif: { kind: 'image', mime: 'image/avif' },
  svg: { kind: 'image', mime: 'image/svg+xml' },
  mp4: { kind: 'video', mime: 'video/mp4' },
  webm: { kind: 'video', mime: 'video/webm' },
  mkv: { kind: 'video', mime: 'video/x-matroska' },
  mov: { kind: 'video', mime: 'video/quicktime' },
  mp3: { kind: 'audio', mime: 'audio/mpeg' },
  wav: { kind: 'audio', mime: 'audio/wav' },
  ogg: { kind: 'audio', mime: 'audio/ogg' },
  opus: { kind: 'audio', mime: 'audio/ogg' },
  m4a: { kind: 'audio', mime: 'audio/mp4' },
  flac: { kind: 'audio', mime: 'audio/flac' },
  aac: { kind: 'audio', mime: 'audio/aac' },
  pdf: { kind: 'document', mime: 'application/pdf' },
  html: { kind: 'document', mime: 'text/html; charset=utf-8' },
  md: { kind: 'document', mime: 'text/markdown; charset=utf-8' },
  txt: { kind: 'document', mime: 'text/plain; charset=utf-8' },
};

export function mediaExtension(value) {
  return path.extname(String(value || '')).replace(/^\./, '').toLowerCase();
}

export function mediaKindForPath(value) {
  // GIF is an image container that ffmpeg also writes as an animation. Callers
  // that produced it from `render_video` override the kind explicitly; by file
  // name alone "image" is the honest answer.
  return MEDIA_TYPES[mediaExtension(value)]?.kind || null;
}

export function mediaMimeType(value) {
  return MEDIA_TYPES[mediaExtension(value)]?.mime || 'application/octet-stream';
}

export function shellQuote(value) {
  const text = String(value);
  if (!text) return "''";
  if (/^[A-Za-z0-9@%_+=:,./-]+$/.test(text)) return text;
  return `'${text.split("'").join(`'\\''`)}'`;
}

export function shellCommand(argv) {
  return argv.map(shellQuote).join(' ');
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function relPath(root, full) {
  return path.relative(root, full).split(path.sep).join('/');
}

// Even numbers only: libx264/vp9 reject odd frame dimensions with a filter
// error the model cannot act on, so normalise before ffmpeg ever sees them.
function evenDimension(value, fallback) {
  const parsed = Math.round(clampNumber(value, 16, 7680, fallback));
  return parsed % 2 === 0 ? parsed : parsed + 1;
}

export function resolveMediaOutput(root, value, allowed, label = 'output') {
  const raw = String(value || '').trim();
  if (!raw) throw new Error(`${label} path is required`);
  const ext = mediaExtension(raw);
  if (!ext) throw new Error(`"${raw}" has no file extension. Use one of: ${allowed.join(', ')}`);
  if (!allowed.includes(ext)) throw new Error(`Unsupported ${label} format ".${ext}". Supported: ${allowed.join(', ')}`);
  const full = safeWorkspacePath(root, raw, { allowMissing: true });
  fs.mkdirSync(path.dirname(full), { recursive: true });
  if (fs.existsSync(full) && fs.statSync(full).isDirectory()) throw new Error(`${relPath(root, full)} is a directory`);
  return { rel: relPath(root, full), full, ext, mime: mediaMimeType(full), kind: mediaKindForPath(full) };
}

export function resolveMediaInput(root, value, label = 'source') {
  const raw = String(value || '').trim();
  if (!raw) throw new Error(`${label} path is required`);
  const full = safeWorkspacePath(root, raw, { allowMissing: false });
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) throw new Error(`${label} file not found: ${raw}`);
  return { rel: relPath(root, full), full, ext: mediaExtension(full), mime: mediaMimeType(full), kind: mediaKindForPath(full) };
}

// ---------------------------------------------------------------------------
// ffmpeg command construction
// ---------------------------------------------------------------------------

export function videoEncoderArgs(ext, { crf = 20, fps = 30 } = {}) {
  if (ext === 'webm') return ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(Math.round(clampNumber(crf + 10, 0, 63, 32))), '-row-mt', '1', '-pix_fmt', 'yuv420p', '-r', String(fps)];
  if (ext === 'gif') return ['-r', String(fps)];
  return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(Math.round(clampNumber(crf, 0, 51, 20))), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', String(fps)];
}

export function audioEncoderArgs(ext, { bitrateKbps = 192 } = {}) {
  const bitrate = `${Math.round(clampNumber(bitrateKbps, 32, 512, 192))}k`;
  if (ext === 'webm' || ext === 'ogg' || ext === 'opus') return ['-c:a', 'libopus', '-b:a', bitrate];
  if (ext === 'wav') return ['-c:a', 'pcm_s16le'];
  if (ext === 'flac') return ['-c:a', 'flac'];
  if (ext === 'mp3') return ['-c:a', 'libmp3lame', '-b:a', bitrate];
  return ['-c:a', 'aac', '-b:a', bitrate];
}

export function scaleFilter(width, height, { fit = 'contain', background = 'black' } = {}) {
  const w = evenDimension(width, 1280);
  const h = evenDimension(height, 720);
  if (fit === 'cover') return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  if (fit === 'stretch') return `scale=${w}:${h}`;
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=${background}`;
}

// concat demuxer input. Each frame is repeated for `seconds`; the last entry is
// duplicated because ffmpeg drops the trailing duration directive otherwise.
export function concatListContent(files, seconds) {
  if (!Array.isArray(files) || !files.length) throw new Error('at least one frame is required');
  const duration = clampNumber(seconds, 0.05, 600, 2.5);
  const lines = [];
  for (const file of files) {
    lines.push(`file ${shellQuote(file)}`);
    lines.push(`duration ${duration}`);
  }
  lines.push(`file ${shellQuote(files[files.length - 1])}`);
  return `${lines.join('\n')}\n`;
}

export function buildSlideshowArgs({
  listFile,
  output,
  ext,
  fps = 30,
  width = 1280,
  height = 720,
  fit = 'contain',
  background = 'black',
  audioFile = '',
  crf = 20,
}) {
  const rate = Math.round(clampNumber(fps, 1, 60, 30));
  const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listFile];
  if (audioFile) args.push('-i', audioFile);

  if (ext === 'gif') {
    const filter = `${scaleFilter(width, height, { fit, background })},fps=${rate},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`;
    args.push('-filter_complex', filter, '-loop', '0', output);
    return args;
  }

  args.push('-vf', `${scaleFilter(width, height, { fit, background })},format=yuv420p`);
  args.push(...videoEncoderArgs(ext, { crf, fps: rate }));
  if (audioFile) args.push(...audioEncoderArgs(ext), '-shortest');
  else args.push('-an');
  args.push(output);
  return args;
}

export function buildClipConcatArgs({ listFile, output, ext, width = 1280, height = 720, fit = 'contain', crf = 20, fps = 30 }) {
  const rate = Math.round(clampNumber(fps, 1, 60, 30));
  return [
    '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `${scaleFilter(width, height, { fit })},format=yuv420p`,
    ...videoEncoderArgs(ext, { crf, fps: rate }),
    ...audioEncoderArgs(ext),
    output,
  ];
}

export function buildConvertArgs({ operation, input, output, outputExt, startMs, durationMs, atMs, width, height, fit, quality, fps }) {
  const args = ['-y'];
  const seek = Number(startMs);
  const at = Number(atMs);
  const duration = Number(durationMs);

  if (operation === 'thumbnail') {
    args.push('-ss', String(clampNumber(at / 1000, 0, 86_400, 0) || 0), '-i', input, '-frames:v', '1');
    if (width || height) args.push('-vf', scaleFilter(width || 640, height || 360, { fit: fit || 'contain' }));
    args.push(output);
    return args;
  }

  if (Number.isFinite(seek) && seek > 0) args.push('-ss', String(seek / 1000));
  args.push('-i', input);
  if (Number.isFinite(duration) && duration > 0) args.push('-t', String(duration / 1000));

  if (operation === 'extract_audio') {
    args.push('-vn', ...audioEncoderArgs(outputExt, { bitrateKbps: quality }), output);
    return args;
  }

  if (operation === 'mute') {
    args.push('-an', '-c:v', 'copy', output);
    return args;
  }

  const kind = MEDIA_TYPES[outputExt]?.kind;
  if (width || height) args.push('-vf', scaleFilter(width || height, height || width, { fit: fit || 'contain' }));

  if (kind === 'image') {
    args.push('-frames:v', '1');
    if (outputExt === 'jpg' || outputExt === 'jpeg' || outputExt === 'webp') args.push('-q:v', String(Math.round(clampNumber(quality, 1, 31, 3))));
    args.push(output);
    return args;
  }

  if (kind === 'audio') {
    args.push('-vn', ...audioEncoderArgs(outputExt, { bitrateKbps: quality }), output);
    return args;
  }

  if (outputExt === 'gif') {
    const rate = Math.round(clampNumber(fps, 1, 30, 12));
    args.push('-filter_complex', `fps=${rate},${scaleFilter(width || 640, height || 360, { fit: fit || 'contain' })},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer`, '-loop', '0', output);
    return args;
  }

  args.push(...videoEncoderArgs(outputExt, { crf: quality, fps: fps || 30 }), ...audioEncoderArgs(outputExt), output);
  return args;
}

export function buildProbeArgs(input) {
  return ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input];
}

export function summarizeProbe(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { throw new Error('ffprobe returned output that is not JSON'); }
  }
  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream?.codec_type === 'video') || null;
  const audio = streams.find((stream) => stream?.codec_type === 'audio') || null;
  const format = parsed?.format || {};
  const durationMs = Number(format.duration) > 0 ? Math.round(Number(format.duration) * 1000) : null;
  const info = {
    formatName: String(format.format_name || '').split(',')[0] || '',
    durationMs,
    bytes: Number(format.size) || null,
    bitrate: Number(format.bit_rate) || null,
    width: video?.width ? Number(video.width) : null,
    height: video?.height ? Number(video.height) : null,
    videoCodec: video?.codec_name || null,
    audioCodec: audio?.codec_name || null,
    frameRate: video?.avg_frame_rate && video.avg_frame_rate !== '0/0' ? video.avg_frame_rate : null,
    sampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    channels: audio?.channels ? Number(audio.channels) : null,
  };
  const lines = [
    info.formatName ? `format: ${info.formatName}` : '',
    info.width && info.height ? `resolution: ${info.width}x${info.height}` : '',
    info.frameRate ? `frame rate: ${info.frameRate}` : '',
    durationMs !== null ? `duration: ${(durationMs / 1000).toFixed(2)}s` : '',
    info.videoCodec ? `video codec: ${info.videoCodec}` : '',
    info.audioCodec ? `audio codec: ${info.audioCodec}${info.channels ? ` (${info.channels}ch` : ''}${info.sampleRate ? `, ${info.sampleRate} Hz)` : info.channels ? ')' : ''}` : '',
    info.bitrate ? `bitrate: ${Math.round(info.bitrate / 1000)} kbps` : '',
    info.bytes ? `size: ${info.bytes} bytes` : '',
  ].filter(Boolean);
  return { info, text: lines.join('\n') || 'No media metadata reported.' };
}

// ---------------------------------------------------------------------------
// Audio container helpers
// ---------------------------------------------------------------------------

// Gemini speech comes back as headerless signed 16-bit PCM. Writing those bytes
// straight to disk produces a file no player opens, so wrap them in RIFF.
export function wavFromPcm(pcm, { sampleRate = 24_000, channels = 1, bitsPerSample = 16 } = {}) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// "audio/L16;codec=pcm;rate=24000" and friends.
export function parsePcmMimeType(mimeType) {
  const value = String(mimeType || '').toLowerCase();
  if (!value.includes('l16') && !value.includes('pcm')) return null;
  const rate = /rate=(\d+)/.exec(value);
  return { sampleRate: rate ? Number(rate[1]) : 24_000, channels: 1, bitsPerSample: 16 };
}

// ---------------------------------------------------------------------------
// Document rendering: Markdown -> HTML -> (Chromium) PDF/PNG
// ---------------------------------------------------------------------------

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

// A deliberately small CommonMark subset: headings, lists, tables, quotes,
// fenced code, rules, images and links. Pulling a Markdown dependency into the
// runtime for document export would widen the server's supply chain for no
// benefit the agent can observe.
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

// Chromium renders from an in-memory document, so workspace-relative images
// have no base URL to resolve against. Inline the small ones and leave the rest
// alone rather than silently shipping a PDF full of broken image icons.
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

// ---------------------------------------------------------------------------
// Built-in PDF writer (fallback when no Chromium is reachable)
// ---------------------------------------------------------------------------

const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792], legal: [612, 1008] };

// Helvetica AFM advance widths for printable ASCII, in 1/1000 em.
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
        // A single word wider than the page still has to land somewhere: break
        // it by character instead of overflowing the media box.
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

export function writeMediaFile(root, target, bytes, ctx = null) {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  fs.mkdirSync(path.dirname(target.full), { recursive: true });
  fs.writeFileSync(target.full, data);
  if (ctx?.sessionId) {
    try { syncSandboxOwnership(ctx.sessionId, root, target.full); }
    catch { /* ownership sync is best effort; the runtime still owns the file */ }
  }
  return data.length;
}

// ---------------------------------------------------------------------------
// Tool surface
// ---------------------------------------------------------------------------

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const MEDIA_TOOL_DEFINITIONS = [
  {
    name: 'generate_image',
    description: 'Generate an image with the configured image model and save it in the workspace (png/jpg/webp). Use it for new artwork, illustrations, icons, textures, mockups or reference frames for a video. For deterministic edits of a file that already exists (resize, crop, convert, thumbnail) use convert_media instead.',
    inputSchema: object({
      prompt: { type: 'string', description: 'What to draw. Be specific about subject, style, composition and colours.' },
      path: { type: 'string', description: 'Workspace-relative output file, for example assets/hero.png' },
      model: { type: 'string', description: 'Optional provider/model override, for example openai/gpt-image-1 or google/gemini-2.5-flash-image.' },
      size: { type: 'string', description: 'WIDTHxHEIGHT such as 1024x1024, 1536x1024 or 1024x1536.' },
      quality: { type: 'string', enum: ['auto', 'low', 'medium', 'high'] },
      background: { type: 'string', enum: ['auto', 'transparent', 'opaque'] },
      count: { type: 'integer', minimum: 1, maximum: 4, description: 'Number of variants. Files after the first get a -2, -3 suffix.' },
      referenceImages: { type: 'array', maxItems: 4, items: { type: 'string' }, description: 'Workspace-relative images to edit or use as visual reference.' },
    }, ['prompt', 'path']),
  },
  {
    name: 'generate_speech',
    description: 'Synthesize speech from text with the configured speech model and save it in the workspace (mp3/wav/ogg/opus/m4a/flac). Use it for voice-over, narration and audio tracks that render_video can mux into a clip.',
    inputSchema: object({
      text: { type: 'string', description: 'Text to speak. Plain text, no markup.' },
      path: { type: 'string', description: 'Workspace-relative output file, for example assets/voice.mp3' },
      voice: { type: 'string', description: 'Provider voice name, for example alloy, verse or Kore.' },
      model: { type: 'string', description: 'Optional provider/model override, for example openai/gpt-4o-mini-tts.' },
      speed: { type: 'number', minimum: 0.25, maximum: 4, description: 'Playback rate multiplier where the provider supports it.' },
      instructions: { type: 'string', description: 'Optional delivery notes such as tone, emotion or pacing.' },
    }, ['text', 'path']),
  },
  {
    name: 'render_document',
    description: 'Render Markdown, HTML or plain text into a PDF, a standalone HTML file or a page image (png/jpg). Use it for reports, invoices, slides-as-PDF, printable summaries and design mockups. Content comes from `content` or from an existing workspace file via `sourcePath`.',
    inputSchema: object({
      path: { type: 'string', description: 'Workspace-relative output file, for example reports/summary.pdf' },
      content: { type: 'string', description: 'Document body. Markdown by default.' },
      sourcePath: { type: 'string', description: 'Workspace-relative source file to render instead of inline content.' },
      format: { type: 'string', enum: ['markdown', 'html', 'text'], description: 'How to interpret the input. Inferred from sourcePath when omitted.' },
      title: { type: 'string' },
      theme: { type: 'string', enum: ['light', 'dark'] },
      css: { type: 'string', description: 'Extra CSS appended to the built-in stylesheet.' },
      fontSize: { type: 'number', minimum: 7, maximum: 32, description: 'Base font size in points.' },
      pageSize: { type: 'string', enum: ['a4', 'letter', 'legal'] },
      landscape: { type: 'boolean' },
      width: { type: 'integer', description: 'Viewport width in px for image output.' },
      height: { type: 'integer', description: 'Viewport height in px for image output.' },
      fullPage: { type: 'boolean', description: 'Capture the whole document for image output. Defaults to true.' },
    }, ['path']),
  },
  {
    name: 'render_video',
    description: 'Build a video from workspace assets with ffmpeg: an image slideshow (`frames` or `framesDir`) or a concatenation of existing clips (`clips`), optionally muxed with an audio track. Writes mp4, webm, mkv, mov or an animated gif.',
    inputSchema: object({
      path: { type: 'string', description: 'Workspace-relative output file, for example media/demo.mp4' },
      frames: { type: 'array', items: { type: 'string' }, maxItems: 400, description: 'Ordered workspace-relative images used as slides.' },
      framesDir: { type: 'string', description: 'Workspace-relative directory of images, taken in name order.' },
      clips: { type: 'array', items: { type: 'string' }, maxItems: 100, description: 'Ordered workspace-relative videos to concatenate.' },
      audio: { type: 'string', description: 'Workspace-relative audio track to mux in.' },
      secondsPerFrame: { type: 'number', minimum: 0.05, maximum: 600, description: 'Seconds each slide stays on screen. Defaults to 2.5.' },
      fps: { type: 'integer', minimum: 1, maximum: 60 },
      width: { type: 'integer' },
      height: { type: 'integer' },
      fit: { type: 'string', enum: ['contain', 'cover', 'stretch'] },
      background: { type: 'string', description: 'Padding colour for fit=contain, for example black or #101014.' },
      quality: { type: 'integer', minimum: 0, maximum: 51, description: 'x264 CRF. Lower is better quality and a bigger file.' },
      timeoutMs: { type: 'integer' },
    }, ['path']),
  },
  {
    name: 'convert_media',
    description: 'Deterministic media transforms with ffmpeg: convert between formats, resize, crop, trim, mute, grab a thumbnail, extract the audio track or turn a clip into a gif. Prefer this over generation for anything that starts from an existing file.',
    inputSchema: object({
      operation: { type: 'string', enum: ['convert', 'resize', 'crop', 'trim', 'thumbnail', 'extract_audio', 'mute', 'gif'] },
      source: { type: 'string', description: 'Workspace-relative input file.' },
      path: { type: 'string', description: 'Workspace-relative output file. Its extension selects the target format.' },
      width: { type: 'integer' },
      height: { type: 'integer' },
      x: { type: 'integer', description: 'Left offset for operation=crop.' },
      y: { type: 'integer', description: 'Top offset for operation=crop.' },
      fit: { type: 'string', enum: ['contain', 'cover', 'stretch'] },
      startMs: { type: 'integer', description: 'Trim start in milliseconds.' },
      durationMs: { type: 'integer', description: 'Trim duration in milliseconds.' },
      atMs: { type: 'integer', description: 'Timestamp for operation=thumbnail.' },
      fps: { type: 'integer', minimum: 1, maximum: 60 },
      quality: { type: 'integer', description: 'Codec quality: CRF for video, q:v for images, kbps for audio.' },
      timeoutMs: { type: 'integer' },
    }, ['operation', 'source', 'path']),
  },
  {
    name: 'media_info',
    description: 'Inspect a workspace media file with ffprobe: container, codecs, resolution, frame rate, duration, bitrate and channel layout. Use it to verify a rendered artifact instead of assuming it is correct.',
    inputSchema: object({
      path: { type: 'string', description: 'Workspace-relative media file.' },
      timeoutMs: { type: 'integer' },
    }, ['path']),
  },
];

export const MEDIA_TOOL_NAMES = MEDIA_TOOL_DEFINITIONS.map((tool) => tool.name);
// ffmpeg/ffprobe spawn processes, so they are gated exactly like bash.
export const MEDIA_SANDBOXED_TOOLS = ['render_video', 'convert_media', 'media_info'];
export const MEDIA_MUTATING_TOOLS = ['generate_image', 'generate_speech', 'render_document', 'render_video', 'convert_media'];

export function isMediaTool(name) {
  return MEDIA_TOOL_NAMES.includes(String(name || '').toLowerCase());
}

export function buildCropArgs({ input, output, x = 0, y = 0, width, height, outputExt }) {
  const w = Math.round(clampNumber(width, 1, 16_384, 0));
  const h = Math.round(clampNumber(height, 1, 16_384, 0));
  if (!w || !h) throw new Error('crop requires width and height');
  const args = ['-y', '-i', input, '-vf', `crop=${w}:${h}:${Math.round(clampNumber(x, 0, 16_384, 0))}:${Math.round(clampNumber(y, 0, 16_384, 0))}`];
  if (MEDIA_TYPES[outputExt]?.kind === 'image') args.push('-frames:v', '1');
  else args.push(...videoEncoderArgs(outputExt, {}));
  args.push(output);
  return args;
}

const DEFAULT_MEDIA_TIMEOUT_MS = 180_000;
const MAX_MEDIA_TIMEOUT_MS = 900_000;
const TEMP_DIR = '.agent-home/media-tmp';

function mediaTimeout(input) {
  return Math.round(clampNumber(input?.timeoutMs, 5_000, MAX_MEDIA_TIMEOUT_MS, DEFAULT_MEDIA_TIMEOUT_MS));
}

function tempFile(root, ctx, suffix) {
  const dir = path.join(root, TEMP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const full = path.join(dir, `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${suffix}`);
  return {
    full,
    write(content) {
      fs.writeFileSync(full, content);
      if (ctx?.sessionId) {
        try { syncSandboxOwnership(ctx.sessionId, root, full); } catch { /* best effort */ }
      }
      return full;
    },
    cleanup() {
      try { fs.rmSync(full, { force: true }); } catch { /* temp file already gone */ }
    },
  };
}

function requireRunner(run, binary) {
  if (typeof run !== 'function') {
    throw Object.assign(new Error(`${binary} cannot run: this deployment has no session sandbox to execute it in.`), { code: 'MEDIA_NO_SANDBOX' });
  }
}

async function runMediaCommand(run, argv, { timeoutMs, binary }) {
  const result = await run(shellCommand(argv), timeoutMs);
  const exit = Number(result?.exit ?? 0);
  const output = String(result?.output ?? '');
  if (exit !== 0) {
    if (/command not found|No such file or directory: ?["']?(ffmpeg|ffprobe)/i.test(output) && /ffmpeg|ffprobe/i.test(output)) {
      throw Object.assign(new Error(`${binary} is not installed in this runtime image. Install ffmpeg (Debian: apt-get install ffmpeg) and retry.`), { code: 'MEDIA_BINARY_MISSING' });
    }
    const tail = output.trim().split('\n').slice(-12).join('\n');
    throw new Error(`${binary} exited with code ${exit}:\n${tail || '(no output)'}`);
  }
  return output;
}

function fileFacts(target) {
  const bytes = fs.existsSync(target.full) ? fs.statSync(target.full).size : 0;
  if (!bytes) throw new Error(`${target.rel} was not produced or is empty`);
  return bytes;
}

function mediaResult({ target, kind, bytes, engine, extra = {}, output, mutated = true }) {
  return {
    output,
    title: target.rel,
    metadata: {
      media: {
        kind: kind || target.kind || 'file',
        path: target.rel,
        mimeType: target.mime,
        bytes,
        engine,
        ...extra,
      },
    },
    mutatedPaths: mutated ? [target.rel] : [],
  };
}

function listFramesDir(root, dir) {
  const full = safeWorkspacePath(root, dir, { allowMissing: false });
  if (!fs.existsSync(full) || !fs.statSync(full).isDirectory()) throw new Error(`framesDir not found: ${dir}`);
  return fs.readdirSync(full)
    .filter((name) => IMAGE_FORMATS.includes(mediaExtension(name)))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((name) => path.join(full, name));
}

// ---------------------------------------------------------------------------
// Document rendering engines
// ---------------------------------------------------------------------------

const CHROMIUM_BINARIES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];

async function renderWithBrowserService({ html, mode, options, ctx, renderPage }) {
  if (typeof renderPage !== 'function' || !ctx?.sessionId) return null;
  try {
    const result = await renderPage({
      action: mode === 'image' ? 'screenshot' : 'pdf',
      html,
      pageSize: options.pageSize,
      landscape: options.landscape,
      width: options.width,
      height: options.height,
      fullPage: options.fullPage,
      imageType: options.imageType,
      timeoutMs: options.timeoutMs,
    });
    const base64 = String(result?.data || '');
    if (!base64) return null;
    return { bytes: Buffer.from(base64, 'base64'), engine: 'chromium' };
  } catch (error) {
    // A missing browser service must degrade to the next engine, not fail the
    // whole document. Anything else is a real rendering error worth surfacing.
    if (/unavailable|not installed|Playwright|socket|ENOENT|required but/i.test(String(error?.message || ''))) return null;
    throw error;
  }
}

async function renderWithLocalChromium({ root, html, mode, options, ctx, run }) {
  if (typeof run !== 'function') return null;
  const probe = await run(`for b in ${CHROMIUM_BINARIES.join(' ')}; do command -v "$b" && break; done`, 15_000).catch(() => null);
  const binary = String(probe?.output || '').trim().split('\n').filter(Boolean).pop();
  if (!binary || Number(probe?.exit ?? 1) !== 0) return null;

  const source = tempFile(root, ctx, '.html');
  const artifact = tempFile(root, ctx, mode === 'image' ? '.png' : '.pdf');
  try {
    source.write(html);
    const argv = [
      binary, '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--disable-dev-shm-usage', '--virtual-time-budget=8000',
    ];
    if (mode === 'image') {
      argv.push(`--screenshot=${artifact.full}`, `--window-size=${Math.round(clampNumber(options.width, 200, 4000, 1280))},${Math.round(clampNumber(options.height, 200, 8000, 1600))}`);
    } else {
      argv.push(`--print-to-pdf=${artifact.full}`, '--no-pdf-header-footer');
      if (options.landscape) argv.push('--landscape');
    }
    argv.push(`file://${source.full}`);
    await runMediaCommand(run, argv, { timeoutMs: options.timeoutMs || 120_000, binary: 'chromium' });
    if (!fs.existsSync(artifact.full) || !fs.statSync(artifact.full).size) return null;
    return { bytes: fs.readFileSync(artifact.full), engine: 'chromium-cli' };
  } catch (error) {
    if (/MEDIA_BINARY_MISSING/.test(String(error?.code || ''))) return null;
    throw error;
  } finally {
    source.cleanup();
    artifact.cleanup();
  }
}

function plainTextFromMarkup(value) {
  return String(value ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function renderDocumentTool({ root, input, ctx, run, renderPage }) {
  const target = resolveMediaOutput(root, input?.path, DOCUMENT_FORMATS, 'document');
  const hasInline = typeof input?.content === 'string' && input.content.length > 0;
  const sourcePath = String(input?.sourcePath || '').trim();
  if (!hasInline && !sourcePath) throw new Error('render_document requires content or sourcePath');

  let source = hasInline ? String(input.content) : '';
  let sourceExt = '';
  if (!hasInline) {
    const inputFile = resolveMediaInput(root, sourcePath, 'sourcePath');
    source = fs.readFileSync(inputFile.full, 'utf8');
    sourceExt = inputFile.ext;
  }

  const declared = String(input?.format || '').toLowerCase();
  const format = ['markdown', 'html', 'text'].includes(declared)
    ? declared
    : sourceExt === 'html' || sourceExt === 'htm' || /^\s*<(!doctype|html)\b/i.test(source)
      ? 'html'
      : sourceExt === 'txt'
        ? 'text'
        : 'markdown';

  const title = String(input?.title || '').trim() || path.basename(target.rel, path.extname(target.rel));

  if (target.ext === 'md' || target.ext === 'txt') {
    const text = format === 'html' ? plainTextFromMarkup(source) : source;
    const bytes = writeMediaFile(root, target, Buffer.from(text, 'utf8'), ctx);
    return mediaResult({ target, kind: 'document', bytes, engine: 'text', output: `Wrote ${bytes} bytes of ${target.ext} to ${target.rel}` });
  }

  const bodyHtml = format === 'html'
    ? source
    : format === 'text'
      ? `<pre class="plain">${escapeHtml(source)}</pre>`
      : markdownToHtml(source);
  const fullDocument = format === 'html' && /<html[\s>]/i.test(source)
    ? source
    : htmlDocument({ title, body: bodyHtml, theme: input?.theme, css: input?.css, fontSize: input?.fontSize });

  if (target.ext === 'html') {
    const bytes = writeMediaFile(root, target, Buffer.from(fullDocument, 'utf8'), ctx);
    return mediaResult({ target, kind: 'document', bytes, engine: 'html', output: `Wrote a standalone HTML document (${bytes} bytes) to ${target.rel}` });
  }

  const inlined = inlineWorkspaceAssets(fullDocument, root, { maxTotalBytes: 3_000_000 });
  const mode = target.ext === 'pdf' ? 'pdf' : 'image';
  const options = {
    pageSize: String(input?.pageSize || 'a4'),
    landscape: Boolean(input?.landscape),
    width: input?.width,
    height: input?.height,
    fullPage: input?.fullPage !== false,
    imageType: target.ext === 'jpg' || target.ext === 'jpeg' ? 'jpeg' : 'png',
    timeoutMs: mediaTimeout(input),
  };

  let rendered = await renderWithBrowserService({ html: inlined.html, mode, options, ctx, renderPage });
  if (!rendered) rendered = await renderWithLocalChromium({ root, html: inlined.html, mode, options, ctx, run });

  if (!rendered && mode === 'pdf') {
    // Last resort so a minimal deployment without Chromium still returns a real
    // PDF. It is text-only and Latin-1, and says so instead of pretending.
    const text = format === 'markdown' || format === 'html' ? plainTextFromMarkup(bodyHtml) : source;
    const bytes = pdfFromText(text, { title, fontSize: input?.fontSize, pageSize: options.pageSize });
    const written = writeMediaFile(root, target, bytes, ctx);
    return mediaResult({
      target,
      kind: 'document',
      bytes: written,
      engine: 'builtin',
      extra: { degraded: true },
      output: `Wrote ${written} bytes to ${target.rel} using the built-in text PDF writer (no Chromium in this runtime, so layout, CSS and images were dropped).`,
    });
  }
  if (!rendered) throw new Error(`Rendering ${target.ext.toUpperCase()} needs Chromium, which is unavailable in this runtime. Render to .html or .pdf instead, or install chromium.`);

  const written = writeMediaFile(root, target, rendered.bytes, ctx);
  const notes = inlined.skipped.length ? ` Skipped ${inlined.skipped.length} image(s) that could not be inlined: ${inlined.skipped.slice(0, 3).join(', ')}.` : '';
  return mediaResult({
    target,
    kind: 'document',
    bytes: written,
    engine: rendered.engine,
    extra: { sourceFormat: format },
    output: `Rendered ${format} to ${target.rel} (${written} bytes).${notes}`,
  });
}

// ---------------------------------------------------------------------------
// ffmpeg-backed tools
// ---------------------------------------------------------------------------

async function renderVideoTool({ root, input, ctx, run }) {
  requireRunner(run, 'ffmpeg');
  const target = resolveMediaOutput(root, input?.path, VIDEO_FORMATS, 'video');
  const timeoutMs = mediaTimeout(input);
  const width = input?.width || 1280;
  const height = input?.height || 720;
  const fps = input?.fps || (target.ext === 'gif' ? 12 : 30);

  const clips = Array.isArray(input?.clips) ? input.clips.filter(Boolean) : [];
  const explicitFrames = Array.isArray(input?.frames) ? input.frames.filter(Boolean) : [];
  const dirFrames = input?.framesDir ? listFramesDir(root, input.framesDir) : [];
  if (!clips.length && !explicitFrames.length && !dirFrames.length) throw new Error('render_video requires frames, framesDir or clips');

  const list = tempFile(root, ctx, '.txt');
  try {
    let argv;
    let summary;
    if (clips.length) {
      const files = clips.map((clip) => resolveMediaInput(root, clip, 'clip').full);
      list.write(`${files.map((file) => `file ${shellQuote(file)}`).join('\n')}\n`);
      argv = ['ffmpeg', ...buildClipConcatArgs({ listFile: list.full, output: target.full, ext: target.ext, width, height, fit: input?.fit, crf: input?.quality, fps })];
      summary = `${files.length} clip(s)`;
    } else {
      const files = explicitFrames.length
        ? explicitFrames.map((frame) => resolveMediaInput(root, frame, 'frame').full)
        : dirFrames;
      if (!files.length) throw new Error('no images were found for the slideshow');
      list.write(concatListContent(files, input?.secondsPerFrame ?? 2.5));
      const audioFile = input?.audio ? resolveMediaInput(root, input.audio, 'audio').full : '';
      argv = ['ffmpeg', ...buildSlideshowArgs({
        listFile: list.full,
        output: target.full,
        ext: target.ext,
        fps,
        width,
        height,
        fit: input?.fit,
        background: input?.background,
        audioFile,
        crf: input?.quality,
      })];
      summary = `${files.length} frame(s)${audioFile ? ' with an audio track' : ''}`;
    }

    await runMediaCommand(run, argv, { timeoutMs, binary: 'ffmpeg' });
    if (ctx?.sessionId) {
      try { syncSandboxOwnership(ctx.sessionId, root, target.full); } catch { /* best effort */ }
    }
    const bytes = fileFacts(target);
    return mediaResult({
      target,
      kind: target.ext === 'gif' ? 'image' : 'video',
      bytes,
      engine: 'ffmpeg',
      extra: { width: evenDimension(width, 1280), height: evenDimension(height, 720), fps },
      output: `Rendered ${target.rel} from ${summary} (${bytes} bytes).`,
    });
  } finally {
    list.cleanup();
  }
}

async function convertMediaTool({ root, input, ctx, run }) {
  requireRunner(run, 'ffmpeg');
  const operation = String(input?.operation || 'convert').toLowerCase();
  const source = resolveMediaInput(root, input?.source, 'source');
  const allowed = [...new Set([...IMAGE_FORMATS, ...VIDEO_FORMATS, ...AUDIO_FORMATS])];
  const target = resolveMediaOutput(root, input?.path, allowed, 'output');
  if (target.full === source.full) throw new Error('source and path must be different files');
  const timeoutMs = mediaTimeout(input);

  const argv = operation === 'crop'
    ? buildCropArgs({ input: source.full, output: target.full, x: input?.x, y: input?.y, width: input?.width, height: input?.height, outputExt: target.ext })
    : buildConvertArgs({
      operation,
      input: source.full,
      output: target.full,
      outputExt: target.ext,
      startMs: input?.startMs,
      durationMs: input?.durationMs,
      atMs: input?.atMs,
      width: input?.width,
      height: input?.height,
      fit: input?.fit,
      quality: input?.quality,
      fps: input?.fps,
    });

  await runMediaCommand(run, ['ffmpeg', ...argv], { timeoutMs, binary: 'ffmpeg' });
  if (ctx?.sessionId) {
    try { syncSandboxOwnership(ctx.sessionId, root, target.full); } catch { /* best effort */ }
  }
  const bytes = fileFacts(target);
  return mediaResult({
    target,
    bytes,
    engine: 'ffmpeg',
    extra: { operation, source: source.rel },
    output: `${operation}: ${source.rel} -> ${target.rel} (${bytes} bytes).`,
  });
}

async function mediaInfoTool({ root, input, run }) {
  requireRunner(run, 'ffprobe');
  const source = resolveMediaInput(root, input?.path, 'path');
  const output = await runMediaCommand(run, ['ffprobe', ...buildProbeArgs(source.full)], { timeoutMs: mediaTimeout(input), binary: 'ffprobe' });
  const jsonStart = output.indexOf('{');
  const { info, text } = summarizeProbe(jsonStart >= 0 ? output.slice(jsonStart) : output);
  return {
    output: `${source.rel}\n${text}`,
    title: source.rel,
    metadata: { media: { kind: source.kind || 'file', path: source.rel, mimeType: source.mime, bytes: fs.statSync(source.full).size, engine: 'ffprobe', ...info } },
    mutatedPaths: [],
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Execute one multimedia tool.
 *
 * @param {object} args
 * @param {string} args.tool          tool name
 * @param {object} args.input         model supplied arguments
 * @param {object} args.ctx           { sessionId, signal, ownerId, onOutput }
 * @param {string} args.root          absolute workspace root
 * @param {(command: string, timeoutMs: number) => Promise<{ output: string, exit: number }>} [args.run]
 *        sandboxed shell runner; omitted when the deployment has no sandbox
 * @param {(payload: object) => Promise<{ data?: string }>} [args.renderPage]
 *        headless Chromium renderer used for documents
 * @param {{ image: Function, speech: Function }} [args.generators]
 *        provider backed generators, injectable for tests
 */
export async function executeMediaTool({ tool, input = {}, ctx = {}, root, run, renderPage, generators = null }) {
  const name = String(tool || '').toLowerCase();
  if (name === 'render_document') return await renderDocumentTool({ root, input, ctx, run, renderPage });
  if (name === 'render_video') return await renderVideoTool({ root, input, ctx, run });
  if (name === 'convert_media') return await convertMediaTool({ root, input, ctx, run });
  if (name === 'media_info') return await mediaInfoTool({ root, input, run });

  if (name === 'generate_image' || name === 'generate_speech') {
    const impl = generators || await import('./media-generation.mjs');
    const generate = name === 'generate_image' ? (generators?.image || impl.generateImageAsset) : (generators?.speech || impl.generateSpeechAsset);
    return await generate({ root, input, ctx });
  }

  throw new Error(`Unknown media tool "${tool}"`);
}
