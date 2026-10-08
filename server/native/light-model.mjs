// Лёгкая («дешёвая и быстрая») модель для фоновых задач вроде самообучения.
// У провайдеров нет метки цены, поэтому выбор честно эвристический: по названию модели
// (mini / nano / lite / flash / haiku / small / instant / 3-8B) и только внутри
// провайдера, который уже выбран для чата, — данные не уходят к другому провайдеру.
// Явный выбор: Z_AGENT_LIGHT_MODEL=провайдер/модель; Z_AGENT_LIGHT_MODEL=off отключает подбор.
import { buildCatalog } from './providers/catalog.mjs';

const LIGHT_TOKENS = ['nano', 'lite', 'haiku', 'flash', 'mini', 'small', 'instant', '3b', '7b', '8b'];
// Лёгкими не считаем рассуждающие, «большие» и нетекстовые модели.
const EXCLUDED =
  /(?:^|[^a-z])(?:opus|sonnet|pro|max|ultra|large|reason(?:er|ing)?|think(?:ing)?|o1|o3|r1|embed(?:ding)?s?|tts|whisper|image|imagen|vision|audio|moderation|realtime|rerank|dall|sora|veo|preview-tts)(?:[^a-z]|$)/i;
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map();

const lightRank = (id) => {
  const text = String(id || '').toLowerCase();
  if (EXCLUDED.test(text)) return -1;
  for (let i = 0; i < LIGHT_TOKENS.length; i++) {
    const token = LIGHT_TOKENS[i];
    if (new RegExp(`(?:^|[^a-z0-9])${token}(?:[^a-z0-9]|$)`).test(text)) return LIGHT_TOKENS.length - i;
  }
  return -1;
};

export function isLightModelId(modelId) {
  return lightRank(modelId) > 0;
}

/** Чистая функция выбора: лучший лёгкий кандидат того же провайдера, что и основная модель. */
export function pickLightModel(models, primary) {
  if (!primary?.providerID) return null;
  const primaryRank = lightRank(primary.modelID);
  if (primaryRank > 0) return null; // чат и так на лёгкой модели
  const sameProvider = (Array.isArray(models) ? models : []).filter(
    (m) => m?.providerID === primary.providerID && m.modelID && m.modelID !== primary.modelID && m.status !== 'error',
  );
  let best = null;
  for (const m of sameProvider) {
    const rank = lightRank(m.modelID);
    if (rank <= 0) continue;
    if (!best || rank > best.rank) best = { rank, model: m };
  }
  return best ? { providerID: best.model.providerID, modelID: best.model.modelID, modelName: best.model.modelName } : null;
}

function configured() {
  const raw = String(process.env.Z_AGENT_LIGHT_MODEL || '').trim();
  if (!raw || raw.toLowerCase() === 'off') return raw.toLowerCase() === 'off' ? 'off' : null;
  const slash = raw.indexOf('/');
  if (slash <= 0 || slash >= raw.length - 1) return null;
  return { providerID: raw.slice(0, slash), modelID: raw.slice(slash + 1) };
}

export function resetLightModelCacheForTests() {
  cache.clear();
}

/**
 * План для фоновой задачи: лёгкая модель первой, модель чата — запасной.
 * Любая ошибка подбора молча возвращает исходный план.
 */
export async function lightModelPlan(ownerId, plan, { catalog = buildCatalog } = {}) {
  try {
    const primary = plan?.candidates?.[0];
    if (!primary) return plan;
    const forced = configured();
    if (forced === 'off') return plan;
    let light = forced;
    if (!light) {
      const key = `${ownerId}\0${primary.providerID}\0${primary.modelID}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_MS) light = hit.model;
      else {
        light = pickLightModel((await catalog(ownerId)).models, primary);
        cache.set(key, { at: Date.now(), model: light });
        if (cache.size > 200) cache.delete(cache.keys().next().value);
      }
    }
    if (!light || (light.providerID === primary.providerID && light.modelID === primary.modelID)) return plan;
    return { ...plan, candidates: [light, ...plan.candidates], explicit: false, locked: false, expandOnFailure: false, light: true };
  } catch {
    return plan;
  }
}
