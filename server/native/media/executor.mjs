import fs from 'node:fs';
import path from 'node:path';
import { safeWorkspacePath } from '../security.mjs';
import { syncSandboxOwnership } from '../sandbox.mjs';
import {
  DOCUMENT_FORMATS,
  IMAGE_FORMATS,
  VIDEO_FORMATS,
  AUDIO_FORMATS,
  MEDIA_TYPES,
  clampNumber,
  mediaExtension,
  mediaKindForPath,
  mediaMimeType,
  resolveMediaInput,
  resolveMediaOutput,
  shellCommand,
  writeMediaFile,
} from './formats.mjs';
import {
  buildClipConcatArgs,
  buildConvertArgs,
  buildCropArgs,
  buildProbeArgs,
  buildSlideshowArgs,
  concatListContent,
  summarizeProbe,
} from './ffmpeg.mjs';
import {
  escapeHtml,
  htmlDocument,
  inlineWorkspaceAssets,
  markdownToHtml,
  pdfFromText,
} from './documents.mjs';
import { generateImageAsset, generateSpeechAsset } from '../media-generation.mjs';

const CHROMIUM_BINARIES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'];
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
        try { syncSandboxOwnership(ctx.sessionId, root, full); } catch {}
      }
      return full;
    },
    cleanup() {
      try { fs.rmSync(full, { force: true }); } catch {}
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

function mediaResult({ target, kind, bytes, engine, extra = {}, output, mutated = true }) {
  return {
    output,
    title: target.rel,
    metadata: {
      media: {
        kind: kind || target.kind || 'file',
        path: target.rel,
        mimeType: target.mime || mediaMimeType(target.rel),
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
    source = fs.readFileSync(inputFile.abs, 'utf8');
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
    const { size } = writeMediaFile(root, target.rel, Buffer.from(text, 'utf8'), ctx);
    return mediaResult({ target, kind: 'document', bytes: size, engine: 'text', output: `Wrote ${size} bytes of ${target.ext} to ${target.rel}` });
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
    const { size } = writeMediaFile(root, target.rel, Buffer.from(fullDocument, 'utf8'), ctx);
    return mediaResult({ target, kind: 'document', bytes: size, engine: 'html', output: `Wrote a standalone HTML document (${size} bytes) to ${target.rel}` });
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

  let rendered = await renderWithBrowserService({ html: inlined, mode, options, ctx, renderPage });
  if (!rendered) rendered = await renderWithLocalChromium({ root, html: inlined, mode, options, ctx, run });

  if (!rendered && mode === 'pdf') {
    const text = format === 'markdown' || format === 'html' ? plainTextFromMarkup(bodyHtml) : source;
    const bytes = pdfFromText(text, { title, fontSize: input?.fontSize, pageSize: options.pageSize });
    const { size } = writeMediaFile(root, target.rel, bytes, ctx);
    return mediaResult({
      target,
      kind: 'document',
      bytes: size,
      engine: 'builtin',
      extra: { degraded: true },
      output: `Wrote ${size} bytes to ${target.rel} using the built-in text PDF writer (no Chromium in this runtime, so layout, CSS and images were dropped).`,
    });
  }
  if (!rendered) throw new Error(`Rendering ${target.ext.toUpperCase()} needs Chromium, which is unavailable in this runtime. Render to .html or .pdf instead, or install chromium.`);

  const { size } = writeMediaFile(root, target.rel, rendered.bytes, ctx);
  return mediaResult({ target, kind: 'document', bytes: size, engine: rendered.engine, output: `Rendered ${target.ext.toUpperCase()} document (${size} bytes) to ${target.rel}` });
}

export async function executeMediaTool({ tool, input = {}, ctx = {}, root, run, renderPage, generators = null }) {
  if (tool === 'generate_image') {
    return (generators?.generateImage || generateImageAsset)({ root, input, ctx });
  }
  if (tool === 'generate_speech') {
    return (generators?.generateSpeech || generateSpeechAsset)({ root, input, ctx });
  }
  if (tool === 'render_document') {
    return renderDocumentTool({ root, input, ctx, run, renderPage });
  }

  if (tool === 'render_video') {
    requireRunner(run, 'ffmpeg');
    const target = resolveMediaOutput(root, input?.path, VIDEO_FORMATS, 'video');
    const audioInput = input?.audio ? resolveMediaInput(root, input.audio, 'audio') : null;
    let frames = Array.isArray(input?.frames) ? input.frames.map((f) => resolveMediaInput(root, f, 'frame').abs) : [];
    if (input?.framesDir) frames = listFramesDir(root, input.framesDir);

    const clips = Array.isArray(input?.clips) ? input.clips.map((c) => resolveMediaInput(root, c, 'clip').abs) : [];
    if (!frames.length && !clips.length) throw new Error('render_video requires frames, framesDir or clips');

    const list = tempFile(root, ctx, '.txt');
    try {
      let argv;
      if (frames.length) {
        list.write(concatListContent(frames, input?.secondsPerFrame));
        argv = ['ffmpeg', ...buildSlideshowArgs({
          listFile: list.full,
          output: target.abs,
          ext: target.ext,
          fps: input?.fps,
          width: input?.width,
          height: input?.height,
          fit: input?.fit,
          background: input?.background,
          audioFile: audioInput?.abs || '',
          crf: input?.quality,
        })];
      } else {
        list.write(concatListContent(clips, 0));
        argv = ['ffmpeg', ...buildClipConcatArgs({
          listFile: list.full,
          output: target.abs,
          ext: target.ext,
          width: input?.width,
          height: input?.height,
          fit: input?.fit,
          crf: input?.quality,
          fps: input?.fps,
        })];
      }
      await runMediaCommand(run, argv, { timeoutMs: mediaTimeout(input), binary: 'ffmpeg' });
      if (ctx?.sessionId) {
        try { syncSandboxOwnership(ctx.sessionId, root, target.abs); } catch {}
      }
      const bytes = fs.existsSync(target.abs) ? fs.statSync(target.abs).size : 0;
      return mediaResult({ target, kind: target.ext === 'gif' ? 'image' : 'video', bytes, engine: 'ffmpeg', output: `Rendered ${target.ext.toUpperCase()} (${bytes} bytes) to ${target.rel}` });
    } finally {
      list.cleanup();
    }
  }

  if (tool === 'convert_media') {
    requireRunner(run, 'ffmpeg');
    const source = resolveMediaInput(root, input?.source, 'source');
    const target = resolveMediaOutput(root, input?.path, [...IMAGE_FORMATS, ...VIDEO_FORMATS, ...AUDIO_FORMATS], 'output');
    const op = String(input?.operation || 'convert').toLowerCase();
    const argv = op === 'crop'
      ? ['ffmpeg', ...buildCropArgs({ input: source.abs, output: target.abs, x: input?.x, y: input?.y, width: input?.width, height: input?.height, outputExt: target.ext })]
      : ['ffmpeg', ...buildConvertArgs({
        operation: op,
        input: source.abs,
        output: target.abs,
        outputExt: target.ext,
        startMs: input?.startMs,
        durationMs: input?.durationMs,
        atMs: input?.atMs,
        width: input?.width,
        height: input?.height,
        fit: input?.fit,
        quality: input?.quality,
        fps: input?.fps,
      })];

    await runMediaCommand(run, argv, { timeoutMs: mediaTimeout(input), binary: 'ffmpeg' });
    if (ctx?.sessionId) {
      try { syncSandboxOwnership(ctx.sessionId, root, target.abs); } catch {}
    }
    const bytes = fs.existsSync(target.abs) ? fs.statSync(target.abs).size : 0;
    return mediaResult({ target, kind: mediaKindForPath(target.rel), bytes, engine: 'ffmpeg', output: `Transformed ${source.rel} -> ${target.rel} (${bytes} bytes)` });
  }

  if (tool === 'media_info') {
    requireRunner(run, 'ffprobe');
    const source = resolveMediaInput(root, input?.path, 'source');
    const argv = ['ffprobe', ...buildProbeArgs(source.abs)];
    const stdout = await runMediaCommand(run, argv, { timeoutMs: mediaTimeout(input), binary: 'ffprobe' });
    const probe = summarizeProbe(stdout);
    return {
      output: probe.text,
      title: source.rel,
      metadata: { probe: probe.info },
      mutatedPaths: [],
    };
  }

  throw new Error(`Unknown media tool: ${tool}`);
}
