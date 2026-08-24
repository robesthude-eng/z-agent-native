import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'z-agent-media-runtime-'));
process.env.Z_AGENT_DATA_DIR = path.join(runtimeRoot, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(runtimeRoot, 'workspaces');

const {
  MEDIA_MUTATING_TOOLS,
  MEDIA_SANDBOXED_TOOLS,
  MEDIA_TOOL_DEFINITIONS,
  MEDIA_TOOL_NAMES,
  buildConvertArgs,
  buildCropArgs,
  buildSlideshowArgs,
  concatListContent,
  isMediaTool,
  markdownToHtml,
  parsePcmMimeType,
  pdfFromText,
  summarizeProbe,
  wavFromPcm,
  wrapPlainText,
} = await import('../server/native/media.mjs');

const { parseImagePayload, parseImageSize, parseModelRef, variantPath } = await import('../server/native/media-generation.mjs');
const { TOOL_DEFINITIONS, mutatesWorkspace, requiresPermission } = await import('../server/native/tools.mjs');

test.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));

test('concat list repeats the final frame so the last slide keeps its duration', () => {
  const content = concatListContent(['/w/a.png', '/w/b.png'], 2);
  assert.deepEqual(content.trim().split('\n'), [
    'file /w/a.png',
    'duration 2',
    'file /w/b.png',
    'duration 2',
    'file /w/b.png',
  ]);
  // Out-of-range and garbage values clamp instead of reaching ffmpeg.
  assert.match(concatListContent(['/w/a.png'], 9000), /duration 600/);
  assert.match(concatListContent(['/w/a.png'], 'soon'), /duration 2\.5/);
  assert.throws(() => concatListContent([], 2), /at least one frame/);
});

test('slideshow args differ for video and gif targets', () => {
  const mp4 = buildSlideshowArgs({ listFile: '/tmp/list.txt', output: '/w/out.mp4', ext: 'mp4' });
  assert.equal(mp4.at(-1), '/w/out.mp4');
  assert.ok(mp4.includes('-an'));
  assert.match(mp4.join(' '), /format=yuv420p/);

  const withAudio = buildSlideshowArgs({ listFile: '/tmp/list.txt', output: '/w/out.mp4', ext: 'mp4', audioFile: '/w/voice.mp3' });
  assert.ok(withAudio.includes('-shortest'));
  assert.ok(!withAudio.includes('-an'));

  const gif = buildSlideshowArgs({ listFile: '/tmp/list.txt', output: '/w/out.gif', ext: 'gif' });
  assert.match(gif.join(' '), /palettegen/);
  assert.deepEqual(gif.slice(-3), ['-loop', '0', '/w/out.gif']);
});

test('convert args cover thumbnail, audio extraction and mute', () => {
  const thumb = buildConvertArgs({ operation: 'thumbnail', input: '/w/in.mp4', output: '/w/out.png', outputExt: 'png', atMs: 5000, width: 640, height: 360 });
  assert.deepEqual(thumb.slice(0, 4), ['-y', '-ss', '5', '-i']);
  assert.ok(thumb.includes('-frames:v'));

  const audio = buildConvertArgs({ operation: 'extract_audio', input: '/w/in.mp4', output: '/w/out.mp3', outputExt: 'mp3', startMs: 1500, durationMs: 4000 });
  assert.deepEqual(audio.slice(0, 3), ['-y', '-ss', '1.5']);
  assert.ok(audio.includes('-t'));
  assert.ok(audio.includes('-vn'));

  const mute = buildConvertArgs({ operation: 'mute', input: '/w/in.mp4', output: '/w/out.mp4', outputExt: 'mp4' });
  assert.deepEqual(mute.slice(-4), ['-an', '-c:v', 'copy', '/w/out.mp4']);
});

test('crop args build the filter and refuse an empty box', () => {
  const args = buildCropArgs({ input: '/w/in.png', output: '/w/out.png', x: 10, y: 20, width: 100, height: 50, outputExt: 'png' });
  assert.ok(args.includes('crop=100:50:10:20'));
  assert.deepEqual(args.slice(-3), ['-frames:v', '1', '/w/out.png']);
  assert.throws(() => buildCropArgs({ input: '/w/in.png', output: '/w/out.png', outputExt: 'png' }), /crop requires width and height/);
});

test('probe summary keeps the numbers and renders a readable block', () => {
  const { info, text } = summarizeProbe(JSON.stringify({
    format: { format_name: 'mov,mp4,m4a', duration: '12.5', size: '2048', bit_rate: '800000' },
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, avg_frame_rate: '30/1' },
      { codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
    ],
  }));
  assert.equal(info.formatName, 'mov');
  assert.equal(info.durationMs, 12_500);
  assert.equal(info.width, 1920);
  assert.equal(info.audioCodec, 'aac');
  assert.match(text, /resolution: 1920x1080/);
  assert.match(text, /duration: 12\.50s/);
  assert.throws(() => summarizeProbe('not json at all'), /not JSON/);
});

test('raw pcm is wrapped in a RIFF header players can open', () => {
  const pcm = Buffer.alloc(8, 1);
  const wav = wavFromPcm(pcm, { sampleRate: 24_000 });
  assert.equal(wav.length, 44 + pcm.length);
  assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
  assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt32LE(40), pcm.length);
});

test('pcm mime detection only fires for headerless audio', () => {
  assert.deepEqual(parsePcmMimeType('audio/L16;codec=pcm;rate=16000'), { sampleRate: 16_000, channels: 1, bitsPerSample: 16 });
  assert.deepEqual(parsePcmMimeType('audio/pcm'), { sampleRate: 24_000, channels: 1, bitsPerSample: 16 });
  assert.equal(parsePcmMimeType('audio/mpeg'), null);
});

test('built-in pdf writer emits a valid skeleton and refuses non latin-1 text', () => {
  const pdf = pdfFromText('Hello world\n\nSecond paragraph', { title: 'Report' });
  const text = pdf.toString('latin1');
  assert.equal(text.slice(0, 8), '%PDF-1.4');
  assert.match(text, /\/Type \/Catalog/);
  assert.match(text, /\/BaseFont \/Helvetica/);
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  // Cyrillic has no WinAnsi code point: fail loudly so render_document can fall
  // back to Chromium instead of writing a file full of blanks.
  assert.throws(() => pdfFromText('Привет'), (error) => error.code === 'PDF_UNSUPPORTED_CHARSET');
});

test('markdown renderer covers headings, code, tables and escaping', () => {
  const html = markdownToHtml('# Title\n\nText with <b>markup</b> and **bold**\n\n```js\nconst a = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /&lt;b&gt;/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<pre><code class="language-js">/);
  assert.match(html, /<table><thead><tr><th>A<\/th>/);
  assert.match(html, /<tbody><tr><td>1<\/td>/);
});

test('plain text wrapping respects the measured width and keeps blank lines', () => {
  const wrapped = wrapPlainText('word '.repeat(60).trim(), { fontSize: 11, maxWidth: 200 });
  assert.ok(wrapped.length > 1);
  assert.ok(wrapped.every((line) => line.length <= 80));
  assert.deepEqual(wrapPlainText('a\n\nb'), ['a', '', 'b']);
});

test('model refs split on the first slash only', () => {
  assert.deepEqual(parseModelRef('openai/gpt-image-1'), { providerID: 'openai', modelID: 'gpt-image-1' });
  assert.deepEqual(parseModelRef('', 'openrouter/google/gemini-2.5-flash-image'), { providerID: 'openrouter', modelID: 'google/gemini-2.5-flash-image' });
  assert.throws(() => parseModelRef('gpt-image-1'), /provider\/model/);
});

test('image size parsing stays inside the supported range', () => {
  assert.deepEqual(parseImageSize('1024x1536'), { width: 1024, height: 1536 });
  assert.equal(parseImageSize(''), null);
  assert.throws(() => parseImageSize('1024 на 1536'), /ШИРИНАxВЫСОТА/);
  assert.throws(() => parseImageSize('32x32'), /64 до 4096/);
});

test('image payloads are read from both openai and google shapes', () => {
  const openai = parseImagePayload({ data: [{ b64_json: Buffer.from('one').toString('base64') }] });
  assert.equal(openai.length, 1);
  assert.equal(openai[0].bytes.toString('utf8'), 'one');
  assert.equal(openai[0].mimeType, 'image/png');

  const google = parseImagePayload({
    candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('two').toString('base64'), mimeType: 'image/jpeg' } }] } }],
  });
  assert.equal(google[0].mimeType, 'image/jpeg');
  assert.equal(google[0].bytes.toString('utf8'), 'two');

  assert.throws(() => parseImagePayload({ candidates: [{ finishReason: 'SAFETY' }] }), /SAFETY/);
});

test('variant paths only get a suffix after the first file', () => {
  assert.equal(variantPath('assets/hero.png', 1), 'assets/hero.png');
  assert.equal(variantPath('assets/hero.png', 3), 'assets/hero-3.png');
  assert.equal(variantPath('assets/hero', 2), 'assets/hero-2');
});

test('media tools are registered with the same rules as the rest of the surface', () => {
  assert.equal(MEDIA_TOOL_DEFINITIONS.length, 6);
  assert.deepEqual([...MEDIA_TOOL_NAMES].sort(), [
    'convert_media',
    'generate_image',
    'generate_speech',
    'media_info',
    'render_document',
    'render_video',
  ]);
  for (const tool of MEDIA_TOOL_DEFINITIONS) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.inputSchema.type, 'object');
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(Array.isArray(tool.inputSchema.required));
  }

  const registered = new Set(TOOL_DEFINITIONS.map((tool) => tool.name));
  for (const name of MEDIA_TOOL_NAMES) {
    assert.ok(registered.has(name), `${name} missing from TOOL_DEFINITIONS`);
    assert.ok(isMediaTool(name));
    assert.ok(requiresPermission(name), `${name} must ask for permission`);
  }

  // Everything that writes a file is a workspace mutation; media_info only reads.
  for (const name of MEDIA_MUTATING_TOOLS) assert.ok(mutatesWorkspace(name));
  assert.ok(!mutatesWorkspace('media_info'));
  // ffmpeg/ffprobe spawn processes, render_document does not have to.
  assert.deepEqual(MEDIA_SANDBOXED_TOOLS, ['render_video', 'convert_media', 'media_info']);
  assert.ok(!MEDIA_SANDBOXED_TOOLS.includes('render_document'));
});
