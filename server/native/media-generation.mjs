import fs from 'node:fs';
import {
  AUDIO_FORMATS,
  IMAGE_FORMATS,
  mediaExtension,
  mediaMimeType,
  parsePcmMimeType,
  resolveMediaInput,
  resolveMediaOutput,
  wavFromPcm,
  writeMediaFile,
} from './media.mjs';
import { callProviderBinary, callProviderJson, providerSpecs } from './providers.mjs';
import { getProviderKey } from './store.mjs';

// Model backed generation: images and speech.
//
// Nothing here spawns a process. The request goes out through the same
// provider channel as a chat completion, which means the API key never leaves
// the trusted runtime, the destination URL passes the same SSRF checks, and a
// configured relay applies automatically. The deterministic half of the media
// stack (ffmpeg, Chromium) lives in media.mjs and runs in the session sandbox
// instead; the two never share a code path.

const DEFAULT_IMAGE_MODEL = 'openai/gpt-image-1';
const DEFAULT_SPEECH_MODEL = 'openai/gpt-4o-mini-tts';
const DEFAULT_VOICE = 'alloy';
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;

/**
 * `provider/model` в пару идентификаторов.
 *
 * Слэш ищется первый, а не последний: у моделей вроде
 * `openrouter/google/gemini-2.5-flash-image` имя содержит собственные слэши,
 * и разрезание с конца дало бы несуществующего провайдера.
 */
export function parseModelRef(value, fallback) {
  const raw = String(value || fallback || '').trim();
  const slash = raw.indexOf('/');
  if (slash < 1 || slash === raw.length - 1) {
    throw Object.assign(
      new Error(`Модель нужно указывать как provider/model, получено «${raw || 'пусто'}»`),
      { statusCode: 400 },
    );
  }
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
}

/** Модель по умолчанию берётся из окружения, чтобы не зашивать вендора в код. */
export function defaultImageModel() {
  return process.env.Z_AGENT_IMAGE_MODEL || DEFAULT_IMAGE_MODEL;
}

export function defaultSpeechModel() {
  return process.env.Z_AGENT_SPEECH_MODEL || DEFAULT_SPEECH_MODEL;
}

/**
 * Автоматический подбор модели и провайдера для генерации изображений:
 * находит активный провайдер пользователя (Sora, Z.ai, OpenAI и др.).
 */
export function resolveImageModelRef(ownerId, modelInput) {
  let specs = {};
  try { specs = providerSpecs(ownerId); } catch { /* ignore */ }
  const raw = String(modelInput || '').trim();

  if (raw) {
    if (raw.includes('/')) {
      const { providerID, modelID } = parseModelRef(raw);
      if (specs[providerID] && getProviderKey(ownerId, providerID)) {
        return { providerID, modelID };
      }
      // Если провайдер с таким ID не найден (например, передали 'openai/gpt-image-1'),
      // подбираем реального провайдера пользователя с этим ключом
      for (const [pId, spec] of Object.entries(specs)) {
        if (!spec.enabled || !getProviderKey(ownerId, pId)) continue;
        const name = (spec.name || '').toLowerCase();
        if (pId === providerID || name === providerID.toLowerCase() || name.includes('sora') || name.includes('openai') || spec.protocol === 'openai') {
          return { providerID: pId, modelID };
        }
      }
    } else {
      // Имя модели без слэша (например 'gpt-image-1' или 'cogview-3-plus')
      for (const [pId, spec] of Object.entries(specs)) {
        if (!spec.enabled || !getProviderKey(ownerId, pId)) continue;
        const name = (spec.name || '').toLowerCase();
        if (raw.startsWith('cogview') && pId === 'zai') return { providerID: pId, modelID: raw };
        if (!raw.startsWith('cogview') && (name.includes('sora') || name.includes('sota') || spec.protocol === 'openai')) {
          return { providerID: pId, modelID: raw };
        }
      }
      for (const [pId, spec] of Object.entries(specs)) {
        if (spec.enabled && getProviderKey(ownerId, pId)) {
          return { providerID: pId, modelID: raw };
        }
      }
    }
  }

  // Модель не указана явно — выбираем лучший провайдер
  const envModel = process.env.Z_AGENT_IMAGE_MODEL;
  if (envModel && envModel.includes('/')) {
    const { providerID, modelID } = parseModelRef(envModel);
    if (specs[providerID] && getProviderKey(ownerId, providerID)) {
      return { providerID, modelID };
    }
  }

  // 1. Sora / True-SOTA (gpt-image-1)
  for (const [pId, spec] of Object.entries(specs)) {
    if (!spec.enabled || !getProviderKey(ownerId, pId)) continue;
    const name = (spec.name || '').toLowerCase();
    if (name.includes('sora') || name.includes('sota') || (spec.baseURL || '').includes('true-sota')) {
      return { providerID: pId, modelID: 'gpt-image-1' };
    }
  }

  // 2. Z.ai (cogview-3-plus)
  if (specs.zai && specs.zai.enabled && getProviderKey(ownerId, 'zai')) {
    return { providerID: 'zai', modelID: 'cogview-3-plus' };
  }

  // 3. Любой доступный провайдер с ключом
  for (const [pId, spec] of Object.entries(specs)) {
    if (spec.enabled && getProviderKey(ownerId, pId)) {
      return { providerID: pId, modelID: 'gpt-image-1' };
    }
  }

  return parseModelRef(defaultImageModel());
}

/**
 * Автоматический подбор модели для синтеза речи (TTS).
 */
export function resolveSpeechModelRef(ownerId, modelInput) {
  let specs = {};
  try { specs = providerSpecs(ownerId); } catch { /* ignore */ }
  const raw = String(modelInput || '').trim();

  if (raw) {
    if (raw.includes('/')) {
      const { providerID, modelID } = parseModelRef(raw);
      if (specs[providerID] && getProviderKey(ownerId, providerID)) {
        return { providerID, modelID };
      }
      for (const [pId, spec] of Object.entries(specs)) {
        if (!spec.enabled || !getProviderKey(ownerId, pId)) continue;
        const name = (spec.name || '').toLowerCase();
        if (pId === providerID || name === providerID.toLowerCase() || name.includes('sora') || name.includes('openai') || spec.protocol === 'openai') {
          return { providerID: pId, modelID };
        }
      }
    } else {
      for (const [pId, spec] of Object.entries(specs)) {
        if (spec.enabled && getProviderKey(ownerId, pId)) {
          return { providerID: pId, modelID: raw };
        }
      }
    }
  }

  const envModel = process.env.Z_AGENT_SPEECH_MODEL;
  if (envModel && envModel.includes('/')) {
    const { providerID, modelID } = parseModelRef(envModel);
    if (specs[providerID] && getProviderKey(ownerId, providerID)) {
      return { providerID, modelID };
    }
  }

  for (const [pId, spec] of Object.entries(specs)) {
    if (!spec.enabled || !getProviderKey(ownerId, pId)) continue;
    const name = (spec.name || '').toLowerCase();
    if (name.includes('sora') || name.includes('sota') || spec.protocol === 'openai') {
      return { providerID: pId, modelID: 'gpt-4o-mini-tts' };
    }
  }

  for (const [pId, spec] of Object.entries(specs)) {
    if (spec.enabled && getProviderKey(ownerId, pId)) {
      return { providerID: pId, modelID: 'gpt-4o-mini-tts' };
    }
  }

  return parseModelRef(defaultSpeechModel());
}

/** `1024x1536` → `{ width, height }`. Пустое значение — размер выбирает провайдер. */
export function parseImageSize(value) {
  if (!value) return null;
  const match = /^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/i.exec(String(value).trim());
  if (!match) {
    throw Object.assign(new Error(`Размер задаётся как ШИРИНАxВЫСОТА, получено «${value}»`), { statusCode: 400 });
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 64 || height < 64 || width > 4096 || height > 4096) {
    throw Object.assign(new Error('Размер изображения допустим от 64 до 4096 пикселей по стороне'), { statusCode: 400 });
  }
  return { width, height };
}

/** Признак «это Google-протокол», а не OpenAI-совместимый. */
function isGoogle(providerID) {
  return /(^|[-_.:])google($|[-_.:])|gemini/i.test(String(providerID || ''));
}

/** Тело запроса для OpenAI-совместимого `images/generations`. */
export function buildOpenAiImageRequest({ model, prompt, size, quality, background, count = 1 }) {
  const body = { model, prompt, n: Math.max(1, Math.min(4, Number(count) || 1)) };
  if (size) body.size = `${size.width}x${size.height}`;
  if (quality && quality !== 'auto') body.quality = quality;
  if (background && background !== 'auto') body.background = background;
  return body;
}

/** Тело запроса для Google `:generateContent` с картинкой на выходе. */
export function buildGoogleImageRequest({ prompt, references = [], size }) {
  const parts = [{ text: size ? `${prompt}\n\nTarget resolution: ${size.width}x${size.height}px.` : prompt }];
  for (const ref of references) {
    parts.push({ inline_data: { mime_type: ref.mimeType, data: ref.bytes.toString('base64') } });
  }
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: { responseModalities: ['IMAGE'] },
  };
}

/** Тело запроса для Google TTS. Возвращает PCM, который упаковывается в WAV. */
export function buildGoogleSpeechRequest({ text, voice }) {
  return {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } } },
    },
  };
}

function decodeBase64(value) {
  const data = Buffer.from(String(value || ''), 'base64');
  if (!data.length) throw new Error('Провайдер вернул пустые данные');
  return data;
}

/**
 * Достаёт картинки из ответа любого из двух протоколов.
 *
 * Разбор терпимый к форме: провайдеры кладут base64 то в `data[].b64_json`, то
 * в `candidates[].content.parts[].inlineData.data`, и падать из-за нового поля
 * там, где картинка всё-таки пришла, — худший исход.
 */
export function parseImagePayload(body) {
  const out = [];
  const data = Array.isArray(body?.data) ? body.data : [];
  for (const item of data) {
    if (item?.b64_json) out.push({ bytes: decodeBase64(item.b64_json), mimeType: item.mime_type || 'image/png' });
  }
  const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
  for (const candidate of candidates) {
    const parts = candidate?.content?.parts || [];
    for (const part of parts) {
      const inline = part?.inlineData || part?.inline_data;
      if (inline?.data) {
        out.push({ bytes: decodeBase64(inline.data), mimeType: inline.mimeType || inline.mime_type || 'image/png' });
      }
    }
  }
  if (!out.length) {
    const refusal = body?.candidates?.[0]?.finishReason || body?.error?.message || '';
    throw new Error(`Провайдер не вернул изображение${refusal ? `: ${refusal}` : ''}`);
  }
  return out;
}

/** Аудио из Google-ответа: inline PCM либо готовый контейнер. */
export function parseAudioPayload(body) {
  const candidates = Array.isArray(body?.candidates) ? body.candidates : [];
  for (const candidate of candidates) {
    for (const part of candidate?.content?.parts || []) {
      const inline = part?.inlineData || part?.inline_data;
      if (inline?.data) {
        return { bytes: decodeBase64(inline.data), mimeType: inline.mimeType || inline.mime_type || '' };
      }
    }
  }
  throw new Error('Провайдер не вернул аудио');
}

/** `assets/hero.png` + 2 → `assets/hero-2.png`. Первый вариант остаётся как есть. */
export function variantPath(rel, index) {
  if (index <= 1) return rel;
  const dot = rel.lastIndexOf('.');
  if (dot < 1) return `${rel}-${index}`;
  return `${rel.slice(0, dot)}-${index}${rel.slice(dot)}`;
}

/** Референсы читаются как файлы воркспейса — путь проверяет resolveMediaInput. */
export function readReferences(root, list) {
  const refs = [];
  let total = 0;
  for (const item of Array.isArray(list) ? list.slice(0, 4) : []) {
    const source = resolveMediaInput(root, item, 'referenceImages');
    if (!IMAGE_FORMATS.includes(source.ext)) throw new Error(`referenceImages: ${source.rel} — не изображение`);
    const bytes = fs.readFileSync(source.full);
    total += bytes.length;
    if (total > MAX_REFERENCE_BYTES) throw new Error('referenceImages: суммарный размер больше 8 МБ');
    refs.push({ bytes, mimeType: mediaMimeType(source.full), rel: source.rel });
  }
  return refs;
}

function assetResult({ target, kind, bytes, engine, extra = {}, output, mutatedPaths }) {
  return {
    output,
    title: target.rel,
    metadata: { media: { kind, path: target.rel, mimeType: target.mime, bytes, engine, ...extra } },
    mutatedPaths: mutatedPaths || [target.rel],
  };
}

/**
 * Генерация изображения в файл воркспейса.
 *
 * @param {{root: string, input: object, ctx: object}} args
 */
export async function generateImageAsset({ root, input = {}, ctx = {} }) {
  const prompt = String(input.prompt || '').trim();
  if (!prompt) throw Object.assign(new Error('prompt обязателен'), { statusCode: 400 });

  const target = resolveMediaOutput(root, input.path, IMAGE_FORMATS, 'path');
  const model = resolveImageModelRef(ctx.ownerId, input.model);
  const size = parseImageSize(input.size);
  const count = Math.max(1, Math.min(4, Number(input.count) || 1));
  const references = readReferences(root, input.referenceImages);
  const google = isGoogle(model.providerID);

  if (references.length && !google) {
    // Правки по образцу у OpenAI живут на multipart-эндпоинте images/edits,
    // которого этот канал не умеет. Молча игнорировать референсы нельзя:
    // модель решит, что образец учтён.
    throw Object.assign(
      new Error('referenceImages поддерживаются только моделями Google; для остальных уберите поле или смените модель'),
      { statusCode: 400 },
    );
  }

  const images = [];
  if (google) {
    // Google отдаёт по одной картинке за вызов — варианты просим повторами.
    for (let i = 0; i < count; i += 1) {
      const body = await callProviderJson(ctx.ownerId ?? null, model, {
        path: `models/${model.modelID}:generateContent`,
        body: buildGoogleImageRequest({ prompt, references, size }),
        signal: ctx.signal,
      });
      images.push(...parseImagePayload(body).slice(0, 1));
    }
  } else {
    const body = await callProviderJson(ctx.ownerId ?? null, model, {
      path: 'images/generations',
      body: buildOpenAiImageRequest({ model: model.modelID, prompt, size, quality: input.quality, background: input.background, count }),
      signal: ctx.signal,
    });
    images.push(...parseImagePayload(body));
  }

  const written = [];
  images.slice(0, count).forEach((image, index) => {
    const rel = variantPath(target.rel, index + 1);
    const slot = index === 0 ? target : resolveMediaOutput(root, rel, IMAGE_FORMATS, 'path');
    const bytes = writeMediaFile(root, slot, image.bytes, ctx);
    written.push({ rel: slot.rel, bytes });
  });

  const total = written.reduce((sum, item) => sum + item.bytes, 0);
  const extra = written.length > 1 ? { variants: written.map((item) => item.rel) } : {};
  return assetResult({
    target,
    kind: 'image',
    bytes: written[0].bytes,
    engine: `${model.providerID}/${model.modelID}`,
    extra,
    mutatedPaths: written.map((item) => item.rel),
    output: written.length > 1
      ? `Создано ${written.length} изображений (${Math.round(total / 1024)} KB): ${written.map((item) => item.rel).join(', ')}`
      : `Изображение сохранено: ${target.rel} (${Math.round(total / 1024)} KB)`,
  });
}

/**
 * Синтез речи в файл воркспейса.
 *
 * У Google-протокола ответ приходит сырым PCM, поэтому для него допустим
 * только `.wav`: перекодировать в mp3 без ffmpeg здесь нечем, а тихо подменять
 * расширение — значит отдать файл, который не откроется.
 */
export async function generateSpeechAsset({ root, input = {}, ctx = {} }) {
  const text = String(input.text || '').trim();
  if (!text) throw Object.assign(new Error('text обязателен'), { statusCode: 400 });

  const target = resolveMediaOutput(root, input.path, AUDIO_FORMATS, 'path');
  const model = resolveSpeechModelRef(ctx.ownerId, input.model);
  const voice = String(input.voice || '').trim();
  const google = isGoogle(model.providerID);

  if (google) {
    if (target.ext !== 'wav') {
      throw Object.assign(
        new Error('Модели Google отдают PCM: для них укажите путь с расширением .wav'),
        { statusCode: 400 },
      );
    }
    const body = await callProviderJson(ctx.ownerId ?? null, model, {
      path: `models/${model.modelID}:generateContent`,
      body: buildGoogleSpeechRequest({ text, voice }),
      signal: ctx.signal,
    });
    const audio = parseAudioPayload(body);
    const pcm = parsePcmMimeType(audio.mimeType);
    const bytes = writeMediaFile(root, target, pcm ? wavFromPcm(audio.bytes, pcm) : audio.bytes, ctx);
    return speechResult({ target, bytes, model, voice });
  }

  const format = target.ext === 'm4a' ? 'aac' : target.ext;
  const body = {
    model: model.modelID,
    input: text,
    voice: voice || DEFAULT_VOICE,
    response_format: format,
  };
  if (Number.isFinite(Number(input.speed))) body.speed = Number(input.speed);
  if (input.instructions) body.instructions = String(input.instructions);

  const audio = await callProviderBinary(ctx.ownerId ?? null, model, {
    path: 'audio/speech',
    body,
    signal: ctx.signal,
  });
  if (audio.mimeType.includes('json')) {
    // Провайдер ответил ошибкой в JSON с кодом 200 — такое встречается у
    // прокси-совместимых шлюзов.
    throw new Error(`Провайдер вернул JSON вместо аудио: ${audio.bytes.toString('utf8').slice(0, 300)}`);
  }
  const bytes = writeMediaFile(root, target, audio.bytes, ctx);
  return speechResult({ target, bytes, model, voice: body.voice });
}

export function speechResult({ target, bytes, model, voice }) {
  return assetResult({
    target,
    kind: 'audio',
    bytes,
    engine: `${model.providerID}/${model.modelID}`,
    extra: voice ? { voice } : {},
    output: `Озвучка сохранена: ${target.rel} (${Math.round(bytes / 1024)} KB${voice ? `, голос ${voice}` : ''})`,
  });
}

/** Размер файла артефакта — для тестов и отладки. */
export function assetBytes(root, rel) {
  const source = resolveMediaInput(root, rel, 'path');
  return fs.statSync(source.full).size;
}

/** Расширение целевого файла — тонкая обёртка, чтобы не тянуть media.mjs в тесты. */
export function assetExtension(value) {
  return mediaExtension(value);
}
