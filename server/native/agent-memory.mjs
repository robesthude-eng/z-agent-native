// Долговременная память и навыки агента: инструменты memory/skill и раздел
// системного промпта. Записи пишет агент (по словам пользователя или по
// итогам задачи) либо сам пользователь в настройках.
import {
  addMemory, deleteSkill, getSkill, listMemory, listSkills, MAX_SKILL_CONTENT, removeMemory, saveSkill,
} from './store.mjs';

const PROMPT_MEMORY_CHARS = 8_000;
const PROMPT_SKILLS = 60;

const KIND_LABEL = { fact: 'fact', preference: 'preference', lesson: 'lesson' };

export function memoryPrompt(ownerId, sessionId) {
  if (!ownerId) return '';
  let memory = [];
  let skills = [];
  try { memory = listMemory(ownerId, { sessionId }); } catch {}
  try { skills = listSkills(ownerId); } catch {}
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
  if (skills.length) {
    lines.push('', 'Skill index (name — when to use):');
    for (const s of skills.slice(0, PROMPT_SKILLS)) lines.push(`- ${s.name} — ${s.description}`);
    if (skills.length > PROMPT_SKILLS) lines.push(`- … ${skills.length - PROMPT_SKILLS} more; use skill action=list.`);
  } else {
    lines.push('', 'No saved skills yet.');
  }
  return lines.join('\n');
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
  if (action === 'list') {
    const skills = listSkills(ownerId);
    return { output: skills.length ? skills.map((s) => `${s.name} — ${s.description} (used ${s.uses}×)`).join('\n') : 'No skills saved yet.', title: 'Навыки' };
  }
  if (action === 'read') {
    const skill = getSkill(ownerId, input?.name, { countUse: true });
    if (!skill) throw new Error(`Skill "${input?.name}" not found. Use skill action=list.`);
    return { output: `# Skill: ${skill.name}\n${skill.description}\n\n${skill.content}`, title: `Навык: ${skill.name}`, metadata: { skill: { action, name: skill.name } } };
  }
  if (action === 'save') {
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
  throw new Error('skill action must be list, read, save or delete');
}
