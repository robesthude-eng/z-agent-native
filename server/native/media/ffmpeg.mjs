import { clampNumber, MEDIA_TYPES, shellQuote } from './formats.mjs';

export function evenDimension(value, fallback) {
  const parsed = Math.round(clampNumber(value, 16, 7680, fallback));
  return parsed % 2 === 0 ? parsed : parsed + 1;
}

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

export function parsePcmMimeType(mimeType) {
  const value = String(mimeType || '').toLowerCase();
  if (!value.includes('l16') && !value.includes('pcm')) return null;
  const rate = /rate=(\d+)/.exec(value);
  return { sampleRate: rate ? Number(rate[1]) : 24_000, channels: 1, bitsPerSample: 16 };
}
