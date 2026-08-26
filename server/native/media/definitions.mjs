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
export const MEDIA_SANDBOXED_TOOLS = ['render_video', 'convert_media', 'media_info'];
export const MEDIA_MUTATING_TOOLS = ['generate_image', 'generate_speech', 'render_document', 'render_video', 'convert_media'];

export function isMediaTool(name) {
  return MEDIA_TOOL_NAMES.includes(String(name || '').toLowerCase());
}
