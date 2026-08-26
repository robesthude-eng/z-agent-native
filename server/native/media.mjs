/**
 * Multimedia generation and rendering facade for Z-Agent Native.
 * Modular implementations live in server/native/media/*.
 */

export {
  IMAGE_FORMATS,
  VIDEO_FORMATS,
  AUDIO_FORMATS,
  DOCUMENT_FORMATS,
  MEDIA_TYPES,
  mediaExtension,
  mediaKindForPath,
  mediaMimeType,
  shellQuote,
  shellCommand,
  resolveMediaOutput,
  resolveMediaInput,
  writeMediaFile,
  clampNumber,
} from './media/formats.mjs';

export {
  evenDimension,
  videoEncoderArgs,
  audioEncoderArgs,
  scaleFilter,
  concatListContent,
  buildSlideshowArgs,
  buildClipConcatArgs,
  buildConvertArgs,
  buildCropArgs,
  buildProbeArgs,
  summarizeProbe,
  wavFromPcm,
  parsePcmMimeType,
} from './media/ffmpeg.mjs';

export {
  escapeHtml,
  markdownToHtml,
  htmlDocument,
  inlineWorkspaceAssets,
  winAnsiCode,
  unsupportedPdfCharacters,
  measureHelvetica,
  wrapPlainText,
  pdfFromText,
} from './media/documents.mjs';

export {
  MEDIA_TOOL_DEFINITIONS,
  MEDIA_TOOL_NAMES,
  MEDIA_SANDBOXED_TOOLS,
  MEDIA_MUTATING_TOOLS,
  isMediaTool,
} from './media/definitions.mjs';

export {
  executeMediaTool,
} from './media/executor.mjs';
