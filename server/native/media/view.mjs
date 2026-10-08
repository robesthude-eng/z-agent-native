import fs from 'node:fs';
import path from 'node:path';
import { syncSandboxOwnership } from '../sandbox.mjs';
import { buildProbeArgs, summarizeProbe } from './ffmpeg.mjs';
import { clampNumber, mediaExtension, resolveMediaInput, shellCommand } from './formats.mjs';

/**
 * view_media: показать модели картинку или кадры видео из воркспейса.
 *
 * Результаты инструментов уходят модели только текстом, поэтому раньше агент
 * не видел ни свои скриншоты, ни сгенерированные картинки, ни видео. Этот
 * инструмент возвращает изображения отдельным полем `visualMedia`; цикл хода
 * прикладывает их к следующему запросу как обычные картинки пользователя.
 * В историю чата (БД) data URL не пишется — только текстовое описание.
 */

const DIRECT_IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const CONVERTIBLE_IMAGE = new Set(['bmp', 'tif', 'tiff', 'avif', 'heic', 'heif', 'ico', 'svg']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'mpg', 'mpeg', 'ogv', 'flv', '3gp']);
const MAX_DIRECT_BYTES = 3 * 1024 * 1024;
const TEMP_DIR = '.agent-home/media-tmp';
const DEFAULT_FRAMES = 6;
const MAX_FRAMES = 12;

export const VIEW_MEDIA_DEFINITION = {
  name: 'view_media',
  description:
    'Look at a workspace image or video with your own eyes. Images (png/jpg/webp/gif and more) are shown to you directly; for a video, evenly spaced key frames with their timestamps are shown. Use it to check screenshots, generated images, rendered pages or videos, and to describe what they contain. The images arrive in the next message right after this tool result.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Workspace-relative image or video file, for example screenshots/page.png or media/demo.mp4' },
      frames: {
        type: 'integer',
        minimum: 1,
        maximum: MAX_FRAMES,
        description: `Video only: how many key frames to look at. Defaults to ${DEFAULT_FRAMES}.`,
      },
      startMs: { type: 'integer', minimum: 0, description: 'Video only: start of the fragment to sample, in milliseconds.' },
      endMs: { type: 'integer', minimum: 0, description: 'Video only: end of the fragment to sample, in milliseconds.' },
      maxSize: {
        type: 'integer',
        minimum: 256,
        maximum: 2048,
        description: 'Longest side in pixels the image is scaled down to. Defaults to 1280 for images and 768 for video frames.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
};

function dataUrl(mime, bytes) {
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
}

function tempPath(root, suffix, ctx) {
  const dir = path.join(root, TEMP_DIR);
  fs.mkdirSync(dir, { recursive: true });
  // ffmpeg работает от пользователя песочницы: каталог должен быть его.
  if (ctx?.sessionId) {
    try {
      syncSandboxOwnership(ctx.sessionId, root, dir);
    } catch {}
  }
  return path.join(dir, `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${suffix}`);
}

function scaleFilter(maxSize) {
  return `scale='min(${maxSize},iw)':'min(${maxSize},ih)':force_original_aspect_ratio=decrease`;
}

async function runOk(run, argv, timeoutMs) {
  const result = await run(shellCommand(argv), timeoutMs);
  const exit = Number(result?.exit ?? 0);
  if (exit !== 0) {
    const tail = String(result?.output || '')
      .trim()
      .split('\n')
      .slice(-8)
      .join('\n');
    throw new Error(`${argv[0]} failed (exit ${exit})${tail ? `:\n${tail}` : ''}`);
  }
  return String(result?.output || '');
}

async function extractJpeg(run, argv, out) {
  try {
    await runOk(run, argv, 120_000);
    if (!fs.existsSync(out) || fs.statSync(out).size === 0) return null;
    return fs.readFileSync(out);
  } finally {
    try {
      fs.rmSync(out, { force: true });
    } catch {}
  }
}

function formatTime(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function viewImage({ root, source, input, run, ctx }) {
  const maxSize = Math.round(clampNumber(input?.maxSize, 256, 2048, 1280));
  const directMime = DIRECT_IMAGE_MIME[source.ext];
  if (directMime && source.size <= MAX_DIRECT_BYTES && (!run || source.ext === 'gif' || source.size <= 600 * 1024)) {
    return {
      output: `Image ${source.rel} (${Math.round(source.size / 1024)} KB) is attached below. Look at it and describe or use what you see.`,
      title: source.rel,
      metadata: { viewed: { path: source.rel, kind: 'image' } },
      mutatedPaths: [],
      visualMedia: [{ name: source.rel, dataUrl: dataUrl(directMime, fs.readFileSync(source.abs)) }],
    };
  }
  if (!run) throw new Error(`Cannot view ${source.rel}: it needs conversion with ffmpeg, but this deployment has no session sandbox.`);
  const out = tempPath(root, '.jpg', ctx);
  const bytes = await extractJpeg(
    run,
    ['ffmpeg', '-y', '-v', 'error', '-i', source.abs, '-frames:v', '1', '-vf', scaleFilter(maxSize), '-q:v', '4', out],
    out,
  );
  if (!bytes) throw new Error(`Could not decode ${source.rel} as an image.`);
  return {
    output: `Image ${source.rel} (scaled to at most ${maxSize}px) is attached below. Look at it and describe or use what you see.`,
    title: source.rel,
    metadata: { viewed: { path: source.rel, kind: 'image' } },
    mutatedPaths: [],
    visualMedia: [{ name: source.rel, dataUrl: dataUrl('image/jpeg', bytes) }],
  };
}

async function viewVideo({ root, source, input, run, ctx }) {
  if (!run) throw new Error(`Cannot view video ${source.rel}: ffmpeg needs a session sandbox, which this deployment does not have.`);
  const probe = summarizeProbe(await runOk(run, ['ffprobe', ...buildProbeArgs(source.abs)], 60_000));
  const durationMs = Math.max(0, Number(probe?.info?.durationMs ?? Number(probe?.info?.duration) * 1000) || 0);
  const count = Math.round(clampNumber(input?.frames, 1, MAX_FRAMES, DEFAULT_FRAMES));
  const maxSize = Math.round(clampNumber(input?.maxSize, 256, 2048, 768));
  const from = Math.max(0, Number(input?.startMs) || 0);
  const to = durationMs > 0 ? Math.min(durationMs, Number(input?.endMs) || durationMs) : Number(input?.endMs) || 0;
  const span = Math.max(0, to - from);
  const stamps = [];
  for (let i = 0; i < count; i++) {
    // Середины равных отрезков: первый и последний кадр часто чёрные.
    stamps.push(span > 0 ? Math.round(from + (span * (i + 0.5)) / count) : from);
    if (span <= 0) break;
  }
  const visualMedia = [];
  const shown = [];
  for (const at of stamps) {
    const out = tempPath(root, '.jpg', ctx);
    let bytes = null;
    try {
      bytes = await extractJpeg(
        run,
        [
          'ffmpeg',
          '-y',
          '-v',
          'error',
          '-ss',
          (at / 1000).toFixed(3),
          '-i',
          source.abs,
          '-frames:v',
          '1',
          '-vf',
          scaleFilter(maxSize),
          '-q:v',
          '5',
          out,
        ],
        out,
      );
    } catch {
      bytes = null;
    }
    if (!bytes) continue;
    visualMedia.push({ name: `${source.rel} @ ${formatTime(at)}`, dataUrl: dataUrl('image/jpeg', bytes) });
    shown.push(formatTime(at));
  }
  if (visualMedia.length === 0) throw new Error(`Could not extract frames from ${source.rel}.`);
  const facts = String(probe?.text || '')
    .split('\n')
    .slice(0, 8)
    .join('\n');
  return {
    output: [
      `Video ${source.rel}: ${visualMedia.length} key frame(s) attached below in order, at ${shown.join(', ')}${durationMs ? ` of ${formatTime(durationMs)}` : ''}.`,
      'Treat them as a storyboard of the clip: describe what happens between them, but say when something can only be inferred. Audio is not included.',
      facts ? `\nffprobe:\n${facts}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    title: source.rel,
    metadata: { viewed: { path: source.rel, kind: 'video', frames: shown } },
    mutatedPaths: [],
    visualMedia,
  };
}

export async function executeViewMedia({ root, input, run, ctx = {} }) {
  const source = resolveMediaInput(root, input?.path, 'source');
  const ext = mediaExtension(source.rel) || source.ext;
  source.ext = String(ext || '').toLowerCase();
  if (VIDEO_EXT.has(source.ext)) return await viewVideo({ root, source, input, run, ctx });
  if (DIRECT_IMAGE_MIME[source.ext] || CONVERTIBLE_IMAGE.has(source.ext)) return await viewImage({ root, source, input, run, ctx });
  throw new Error(`view_media supports images and videos; "${source.rel}" is neither. Use read for text files.`);
}
