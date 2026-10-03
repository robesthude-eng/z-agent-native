import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-routing-'));
process.env.Z_AGENT_DATA_DIR = path.join(root, 'data');
process.env.Z_AGENT_WORKSPACES_DIR = path.join(root, 'workspaces');
delete process.env.Z_AGENT_IMAGE_MODEL;
delete process.env.Z_AGENT_SPEECH_MODEL;
const store = await import('../server/native/store.mjs');
const configs = await import('../server/native/provider-configs.mjs');
const providers = await import('../server/native/providers.mjs');
const media = await import('../server/native/media-generation.mjs');
test.after(() => { providers.setProviderTransportForTests(null); fs.rmSync(root, { recursive: true, force: true }); });
let counter = 0;
const owners = new Set();
function channel(protocol, id, enabled = true, owner = `media-${++counter}@example.com`) {
  if (!owners.has(owner)) { store.createUser(owner, 'test-hash'); owners.add(owner); }
  configs.upsertProviderConfig(owner, { id, name: 'A neutral label', protocol, baseURL: `https://1.1.1.1/${protocol === 'google' ? 'v1beta' : 'v1'}`, enabled });
  store.setProviderKey(owner, id, 'test-key');
  return owner;
}

test('Google protocol with a UI-generated channel ID uses generateContent for image and speech', async () => {
  const id = 'channel_a91c';
  const ownerId = channel('google', id);
  const requests = [];
  providers.setProviderTransportForTests(async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), body });
    const audio = body.generationConfig.responseModalities[0] === 'AUDIO';
    return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: audio ? 'audio/L16;rate=24000' : 'image/png', data: Buffer.from([0, 0, 0, 0]).toString('base64') } }] } }] });
  });
  fs.writeFileSync(path.join(root, 'reference.png'), Buffer.from([1, 2, 3]));
  const image = await media.generateImageAsset({ root, input: { prompt: 'Image', path: 'image.png', model: `${id}/image-model`, referenceImages: ['reference.png'] }, ctx: { ownerId } });
  const audio = await media.generateSpeechAsset({ root, input: { text: 'Hello', path: 'speech.wav', model: `${id}/speech-model` }, ctx: { ownerId } });
  assert.deepEqual(requests.map((r) => new URL(r.url).pathname), ['/v1beta/models/image-model:generateContent', '/v1beta/models/speech-model:generateContent']);
  assert.equal(fs.readFileSync(path.join(root, 'speech.wav')).subarray(0, 4).toString(), 'RIFF');
  assert.equal(image.metadata.media.bytes, 4);
  assert.equal(image.metadata.media.mimeType, 'image/png');
  assert.equal(audio.metadata.media.bytes, media.assetBytes(root, 'speech.wav'));
  assert.equal(audio.metadata.media.mimeType, 'audio/wav');
  assert.equal(requests[0].body.contents[0].parts[1].inline_data.data, 'AQID');
  assert.equal(fs.existsSync(path.join(root, '[object Object]')), false);
});

test('OpenAI protocol uses OpenAI endpoints even when its ID says google', async () => {
  const id = 'google-gemini-relay';
  const ownerId = channel('openai', id);
  const requests = [];
  providers.setProviderTransportForTests(async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return String(url).endsWith('/audio/speech')
      ? new Response(Buffer.from('test-audio'), { headers: { 'content-type': 'audio/mpeg' } })
      : Response.json({ data: [{ b64_json: Buffer.from('test-image').toString('base64') }] });
  });
  await media.generateImageAsset({ root, input: { prompt: 'Image', path: 'openai.png', model: `${id}/vendor/image-model` }, ctx: { ownerId } });
  await media.generateSpeechAsset({ root, input: { text: 'Hello', path: 'speech.mp3', model: `${id}/speech-model` }, ctx: { ownerId } });
  assert.deepEqual(requests.map((r) => new URL(r.url).pathname), ['/v1/images/generations', '/v1/audio/speech']);
  assert.equal(requests[0].body.model, 'vendor/image-model');
  assert.equal(fs.readFileSync(path.join(root, 'openai.png')).toString(), 'test-image');
  assert.equal(fs.readFileSync(path.join(root, 'speech.mp3')).toString(), 'test-audio');
});

test('explicit missing or disabled channels never fall back to another provider', () => {
  const owner = channel('openai', 'channel_good');
  channel('google', 'channel_disabled', false, owner);
  for (const resolve of [media.resolveImageModelRef, media.resolveSpeechModelRef]) {
    assert.throws(() => resolve(owner, 'missing/model'), /Неизвестный провайдер/);
    assert.throws(() => resolve(owner, 'channel_disabled/model'), /выключен/);
    assert.deepEqual(resolve(owner, 'some-model'), { providerID: 'channel_good', modelID: 'some-model' });
    process.env.Z_AGENT_IMAGE_MODEL = 'missing/model';
    if (resolve === media.resolveImageModelRef) assert.throws(() => resolve(owner), /Неизвестный/);
    delete process.env.Z_AGENT_IMAGE_MODEL;
  }
  channel('google', 'channel_second', true, owner);
  assert.throws(() => media.resolveImageModelRef(owner, 'some-model'), /явно выбранный/);
  assert.deepEqual(media.resolveImageModelRef(owner, 'channel_good/model'), { providerID: 'channel_good', modelID: 'model' });
});

test('unsupported protocols are rejected before making media requests', () => {
  const owner = channel('anthropic', 'channel_text');
  assert.throws(() => media.resolveImageModelRef(owner, 'channel_text/model'), /не поддерживает/);
  assert.throws(() => media.resolveSpeechModelRef(owner, 'speech-model'), /явно выбранный/);
});
