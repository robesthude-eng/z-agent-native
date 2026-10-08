import { getSkill } from '../native/store/memory.mjs';
import { readJson, sendJson } from '../native/json.mjs';
import { configureSkill, chatSkillSettings, installSkill, setChatSkillSettings } from '../native/skills/library.mjs';
import { discoverSkills } from '../native/skills/installer.mjs';

export async function handleSkillRoutes(req, res, p, ownerId) {
  if (['/api/user/skills/discover', '/api/user/skills/install'].includes(p) && req.method === 'POST') {
    const body = await readJson(req, 24 * 1024 * 1024);
    const result = p.endsWith('/discover') ? await discoverSkills(ownerId, body) : await installSkill(ownerId, body);
    sendJson(res, 200, result);
    return true;
  }
  const config = /^\/api\/user\/skills\/(skl_[A-Za-z0-9_-]+)$/.exec(p);
  if (config && req.method === 'GET') {
    const skill = getSkill(ownerId, config[1]);
    sendJson(res, skill ? 200 : 404, skill || { error: 'Skill not found' });
    return true;
  }
  if (config && req.method === 'PATCH') {
    sendJson(res, 200, configureSkill(ownerId, config[1], await readJson(req, 16 * 1024)));
    return true;
  }
  const chat = /^\/api\/session\/(ses_[A-Za-z0-9]+)\/skills$/.exec(p);
  if (chat && ['GET', 'PUT'].includes(req.method)) {
    const result =
      req.method === 'GET' ? chatSkillSettings(ownerId, chat[1]) : setChatSkillSettings(ownerId, chat[1], await readJson(req, 32 * 1024));
    sendJson(res, 200, result);
    return true;
  }
  return false;
}
