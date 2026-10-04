import { sendJson } from '../native/json.mjs';
import { publicChatView } from '../native/share-view.mjs';
import { resolveChatShare } from '../native/store.mjs';

// Публичный маршрут без входа: GET /api/public/share/<token>.
export function handlePublicShareRoutes(req, res, p) {
  const m = /^\/api\/public\/share\/([^/]+)$/.exec(p);
  if (!m) return false;
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }
  const share = resolveChatShare(m[1]);
  if (!share) {
    sendJson(res, 404, { error: 'Ссылка недействительна или отозвана' });
    return true;
  }
  res.setHeader('x-robots-tag', 'noindex, nofollow');
  res.setHeader('cache-control', 'no-store');
  sendJson(res, 200, publicChatView(share));
  return true;
}
