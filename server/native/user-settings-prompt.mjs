// Персональные настройки агента из окна настроек (prefs.appSettings).
// Пишет их сам владелец аккаунта, поэтому это его указания, а не данные
// из внешних источников; правила системного промпта остаются приоритетнее.
import { getPrefs } from './store.mjs';

const MAX = 4000;

const STYLE = {
  concise: 'Answer concisely: lead with the result, skip preambles and recaps, keep explanations short unless asked.',
  detailed: 'Answer in detail: explain reasoning, trade-offs and next steps; include examples where useful.',
};

const LANGUAGE = {
  ru: 'Always reply in Russian, regardless of the language of the request or sources.',
  en: 'Always reply in English, regardless of the language of the request or sources.',
};

export function userSettingsFrom(prefs) {
  const raw = prefs?.appSettings?.value;
  return raw && typeof raw === 'object' ? raw : {};
}

export function buildUserSettingsPrompt(settings = {}) {
  const lines = [];
  const style = STYLE[settings.responseStyle];
  const lang = LANGUAGE[settings.responseLanguage];
  if (style) lines.push(`- ${style}`);
  if (lang) lines.push(`- ${lang}`);
  const custom = typeof settings.customInstructions === 'string' ? settings.customInstructions.trim().slice(0, MAX) : '';
  if (!lines.length && !custom) return '';
  const out = ['[Owner preferences from settings — follow them unless they conflict with the rules above]'];
  out.push(...lines);
  if (custom) out.push('Custom instructions from the owner:', custom);
  return out.join('\n');
}

export function userSettingsPrompt(ownerId) {
  if (!ownerId) return '';
  try { return buildUserSettingsPrompt(userSettingsFrom(getPrefs(ownerId))); }
  catch { return ''; }
}

/** Переключатели возможностей агента из настроек; по умолчанию всё включено. */
export function agentFeatureFlags(settings = {}) {
  const on = (key) => settings[key] !== false;
  return {
    review: on('agentReview'),
    visualCheck: on('agentVisualCheck'),
    autoResume: on('agentAutoResume'),
    dossier: on('agentDossier'),
    memory: on('agentMemory'),
  };
}

export function agentFeatures(ownerId) {
  try { return agentFeatureFlags(userSettingsFrom(getPrefs(ownerId))); }
  catch { return agentFeatureFlags({}); }
}
