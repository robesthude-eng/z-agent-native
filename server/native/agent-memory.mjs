// Долговременная память и навыки агента: инструменты memory/skill и раздел
// системного промпта. Записи пишет агент (по словам пользователя или по
// итогам задачи) либо сам пользователь в настройках.
import {
  addMemory, deleteSkill, getSkill, listMemory, MAX_SKILL_CONTENT, removeMemory, saveSkill,
} from './store.mjs';
import { availableSkills, chatSkillSettings, installSkill, materializeSkill, setChatSkillSettings, skillsPrompt } from './skills/library.mjs';
import { discoverSkills } from './skills/installer.mjs';

const PROMPT_MEMORY_CHARS = 8_000;

const KIND_LABEL = { fact: 'fact', preference: 'preference', lesson: 'lesson' };

export function memoryPrompt(ownerId, sessionId, { includeSkills = true } = {}) {
  if (!ownerId) return '';
  let memory = [];
  try { memory = listMemory(ownerId, { sessionId }); } catch {}
  const lines = [
    '[Long-term memory and skills]',
    'Memory persists across chats. Use it to avoid repeating past mistakes and to respect the owner\'s stable preferences.',
    'Save to memory (tool `memory`, action=add) WITHOUT being asked when: the user corrects you ("не так", "я же говорил", "у меня другое"), states a lasting preference or rule, or reveals a durable environment fact (server, OS, stack, paths, accounts — never secrets/passwords/tokens). Write one short self-contained imperative rule or fact per entry, e.g. "Сервер пользователя — Ubuntu 24.04, деплой через ./run.sh". Use scope=chat for facts that only matter in this chat/project. Mention briefly in your answer that you remembered it.',
    'Remove or replace entries that turn out to be wrong (action=remove).',
    'Skills are reusable step-by-step recipes. Before starting a task, check the skill index below; if one matches, load it with skill action=read and follow it (adapting as needed). After you SUCCESSFULLY finish a non-trivial, repeatable procedure (deploy, environment setup, build pipeline, data-processing recipe, debugging playbook) that is not yet covered, save it with skill action=save: concrete commands, file paths, pitfalls you hit and how you fixed them, and how to verify. Update an existing skill instead of creating a near-duplicate. Never put secrets into skills.',
  ];
  if (memory.length) {
    lines.push('', 'Remembered (oldest first; ids in brackets):');
    let used = 0;
    const picked = [];
    for (const m of [...memory].reverse()) {
      const line = `- [${m.id}] (${KIND_LABEL[m.kind] || 'fact'}${m.scope === 'global' ? '' : ', this chat'}) ${m.text}`;
      if (used + line.length > PROMPT_MEMORY_CHARS) break;
      used += line.length;
      picked.push(line);
    }
    lines.push(...picked.reverse());
    if (picked.length < memory.length) lines.push(`- … ${memory.length - picked.length} older entries omitted; use memory action=list to see all.`);
  } else {
    lines.push('', 'Memory is empty so far.');
  }
  return [lines.join('\n'), includeSkills ? skillsPrompt(ownerId, sessionId) : ''].filter(Boolean).join('\n\n');
}

export function executeMemoryTool(input, ctx = {}) {
  const ownerId = ctx.ownerId;
  if (!ownerId) throw new Error('memory requires an authenticated owner');
  const action = String(input?.action || '').toLowerCase();
  if (action === 'add') {
    const scope = input?.scope === 'chat' && ctx.sessionId ? ctx.sessionId : 'global';
    const entry = addMemory(ownerId, { text: input?.text, kind: input?.kind, scope, source: 'agent' });
    return {
      output: entry.duplicate ? `Already remembered: [${entry.id}] ${entry.text}` : `Remembered [${entry.id}] (${entry.kind}, ${scope === 'global' ? 'all chats' : 'this chat'}): ${entry.text}`,
      title: `Запомнил: ${entry.text.slice(0, 80)}`,
      metadata: { memory: { action, id: entry.id } },
    };
  }
  if (action === 'remove') {
    const ok = removeMemory(ownerId, String(input?.id || ''));
    return { output: ok ? `Removed ${input.id}` : `No memory entry ${input?.id}`, title: 'Память: удалено', metadata: { memory: { action, ok } } };
  }
  if (action === 'list') {
    const items = listMemory(ownerId, { sessionId: ctx.sessionId });
    return {
      output: items.length ? items.map((m) => `[${m.id}] (${m.kind}${m.scope === 'global' ? '' : ', this chat'}) ${m.text}`).join('\n') : 'Memory is empty.',
      title: 'Память',
    };
  }
  throw new Error('memory action must be add, remove or list');
}

export function executeSkillTool(input, ctx = {}) {
  const ownerId = ctx.ownerId;
  if (!ownerId) throw new Error('skill requires an authenticated owner');
  const action = String(input?.action || '').toLowerCase();
  if (ctx.sessionId && chatSkillSettings(ownerId, ctx.sessionId).mode === 'off' && action !== 'list') throw new Error('Skills are disabled in this chat');
  if (action === 'discover' || action === 'install') {
    const settings = chatSkillSettings(ownerId, ctx.sessionId);
    if (settings.mode === 'off' || !settings.allowInstall) throw new Error('Agent skill discovery/installation is disabled in this chat');
    return (async () => {
      const result = action === 'discover' ? await discoverSkills(ownerId, input, ctx.signal) : await installSkill(ownerId, input, ctx.signal);
      return { output: JSON.stringify(result, null, 2), title: action === 'discover' ? 'Доступные скиллы в источнике' : `Установлен навык: ${result.name}`, metadata: { skill: { action, name: result.name, source: result.source } } };
    })();
  }
  if (action === 'enable' || action === 'disable') {
    const settings = chatSkillSettings(ownerId, ctx.sessionId);
    const skill = getSkill(ownerId, input.name);
    if (!skill || !skill.enabled) throw new Error('Skill is missing or disabled in the library');
    if (action === 'enable' && !skill.autoUse && !settings.selected.includes(skill.name)) throw new Error('This is a manual-only skill; ask the user to select it in the chat skill picker');
    const selected = settings.selected.filter((n) => n !== skill.name);
    const excluded = settings.excluded.filter((n) => n !== skill.name);
    if (action === 'enable') selected.push(skill.name); else excluded.push(skill.name);
    const next = setChatSkillSettings(ownerId, ctx.sessionId, { selected, excluded });
    return { output: JSON.stringify(next), title: `Навык ${action === 'enable' ? 'включён' : 'выключен'}: ${skill.name}` };
  }
  if (action === 'list') {
    const query = String(input?.query || '').toLowerCase();
    const skills = availableSkills(ownerId, ctx.sessionId).filter((s) => !query || `${s.name} ${s.description}`.toLowerCase().includes(query));
    return { output: skills.length ? skills.map((s) => `${s.name} — ${s.description} (used ${s.uses}×)`).join('\n') : 'No skills saved yet.', title: 'Навыки' };
  }
  if (action === 'read') {
    const { skill, directory } = materializeSkill(ownerId, ctx.sessionId, ctx.workspace, input?.name);
    const body = directory ? skill.content.replace(/\$\{(?:CLAUDE_SKILL_DIR|SKILL_DIR)\}/g, directory) : skill.content;
    return { output: `# Skill: ${skill.name}\n${skill.description}\n${directory ? `Resources copied to ${directory}; resolve relative file references from this directory. Inspect scripts before execution.\n` : ''}${skill.warnings?.length ? `Compatibility notes: ${skill.warnings.join('; ')}\n` : ''}\n${body}`, title: `Навык: ${skill.name}`, metadata: { skill: { action, name: skill.name, directory, revision: skill.source?.revision } } };
  }
  if (action === 'save') {
    if (getSkill(ownerId, input?.name)?.source?.type) throw new Error('Imported skills cannot be overwritten by skill save; use explicit install replace=true for updates');
    const content = String(input?.content || '');
    if (content.length > MAX_SKILL_CONTENT) throw new Error(`Skill content is limited to ${MAX_SKILL_CONTENT} chars; keep it to the essential steps.`);
    const skill = saveSkill(ownerId, { name: input?.name, description: input?.description, content });
    return {
      output: `${skill.updatedExisting ? 'Updated' : 'Saved new'} skill "${skill.name}".`,
      title: `${skill.updatedExisting ? 'Навык обновлён' : 'Новый навык'}: ${skill.name}`,
      metadata: { skill: { action, name: skill.name, updated: Boolean(skill.updatedExisting) } },
    };
  }
  if (action === 'delete') {
    const ok = deleteSkill(ownerId, input?.name);
    return { output: ok ? `Deleted skill ${input.name}` : `No skill ${input?.name}`, title: 'Навык удалён' };
  }
  throw new Error('skill action must be list, read, discover, install, enable, disable, save or delete');
}
