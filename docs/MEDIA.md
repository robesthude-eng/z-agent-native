# Media generation

The agent can produce images, speech, documents, video and format conversions
directly in the session workspace. Every artifact is a normal workspace file, so
the file tree, preview, diff and download paths that already exist keep working —
nothing is stored outside `/workspaces/<session>`.

## Tool surface

| Tool | Produces | Engine |
| --- | --- | --- |
| `generate_image` | `png` `jpg` `webp` | image model of the configured provider |
| `generate_speech` | `mp3` `wav` `ogg` `opus` `m4a` `flac` | speech model of the configured provider |
| `render_document` | `pdf` `html` `png` `txt` `md` | Chromium → local Chromium → built-in writer |
| `render_video` | `mp4` `webm` `mov` `gif` | ffmpeg |
| `convert_media` | any supported image/audio/video target | ffmpeg |
| `media_info` | text report | ffprobe |

All six are declared in `server/native/media.mjs` next to the code that executes
them, and spliced into `TOOL_DEFINITIONS` in `server/native/tools.mjs`.

### generate_image

`prompt`, `path`, optional `model`, `size` (`WIDTHxHEIGHT`), `quality`,
`background`, `count` (1–4) and `referenceImages` (up to 4 workspace images).
Variants after the first are written as `hero-2.png`, `hero-3.png`.
`referenceImages` requires a Google-protocol model; with an OpenAI-protocol model
the call fails instead of silently dropping the references.

### generate_speech

`text`, `path`, optional `voice`, `model`, `format`. Google models return
headerless PCM, which is wrapped into RIFF/WAV before it hits the disk — so a
Google speech model can only write `.wav`. OpenAI-protocol models write the
container implied by the file extension.

### render_document

Markdown or HTML in, a document out. Three engines are tried in order:

1. **browser service** — the isolated Chromium container (`chromium-service`).
2. **local chromium** — any of `chromium`, `chromium-browser`, `google-chrome`,
   `google-chrome-stable` on `PATH`, used in single-container and dev setups.
3. **built-in writer** — a dependency-free PDF/HTML writer.

Degradation is deliberate and visible: when the built-in writer is used the
result is marked `degraded` and the UI shows “simplified render without
Chromium”. The built-in writer covers Latin-1 only; Cyrillic or CJK text raises
`PDF_UNSUPPORTED_CHARSET` instead of printing blanks, because a silently empty
document is worse than a clear failure.

### render_video

Two modes: a slideshow from workspace images (`frames`, `secondsPerFrame`,
optional `audio`) and concatenation of existing clips (`clips`). Both go through
ffmpeg with even-dimension scaling, `yuv420p` output for video targets and a
palette pass for GIF.

### convert_media / media_info

`convert_media` handles convert, resize, crop, trim, thumbnail, extract_audio and
mute. `media_info` runs `ffprobe` and returns both a readable block and parsed
fields (duration, resolution, codecs, bitrate).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `Z_AGENT_IMAGE_MODEL` | `openai/gpt-image-1` | default `provider/model` for `generate_image` |
| `Z_AGENT_SPEECH_MODEL` | `openai/gpt-4o-mini-tts` | default `provider/model` for `generate_speech` |

Both accept any configured provider, including relay and OpenAI-compatible
endpoints. The model reference splits on the **first** slash, so
`openrouter/google/gemini-2.5-flash-image` resolves to provider `openrouter`.
Anthropic and the fixture provider have no media endpoints and are rejected with
a readable message rather than a 404 from the provider.

ffmpeg, ffprobe and a font with Cyrillic coverage are runtime dependencies of the
runtime image; without them the ffmpeg-backed tools report that the binary is
missing and the rest of the tool surface keeps working.

## Security

- Output and input paths go through the same workspace guards as `write`/`read`:
  no traversal, no sensitive paths, ownership synced for sandboxed sessions.
- ffmpeg/ffprobe are gated exactly like `bash`: they only run when a session
  sandbox is available, and the command goes through `assertShellCommandAllowed`.
- `render_document` is intentionally **not** sandbox-gated: without a sandbox it
  still produces PDF/HTML through the built-in writer without spawning anything.
- All six tools require permission (`requiresPermission`), since generation costs
  provider credits and the rest write files.
- URL rendering keeps the browser SSRF policy: no loopback, no private ranges,
  proxy honoured when configured.
- Provider responses are read with a hard byte ceiling (64 MB) and a request
  timeout, so a broken provider cannot exhaust memory.

## UI

Tool cards render finished artifacts inline: images, `<video>` and `<audio>`
players, variant chips, size/mime/engine footer and a download link. The files
panel previews video, audio and PDF in addition to images and text. While the
agent works, the indicator uses the AI loader (`src/components/ui/ai-loader.tsx`,
styles in `src/index.css`).

## Tests

`tests/media.test.mjs` covers the pure parts: ffmpeg argument builders, the concat
list, probe summarisation, WAV wrapping, the PDF writer, the Markdown renderer,
model/size parsing, provider payload parsing and the tool registration rules.

```bash
node --test tests/media.test.mjs
npm run test:native
```
