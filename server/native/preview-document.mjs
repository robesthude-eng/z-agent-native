import fs from 'node:fs';
import path from 'node:path';

const HTML_NAME = /^[A-Za-z0-9._-]{1,80}\.html?$/i;

// Каталоги, куда по умолчанию собирают фронтенды (vite/webpack/next export).
// Превью ищет готовую страницу и в них — как в корне воркспейса, так и на
// уровень ниже: распакованный архив почти всегда лежит в подпапке проекта.
const BUILD_DIRS = ['dist', 'build', 'out'];
// Служебные каталоги, в которых страницу превью искать не стоит.
const SKIP_DIRS = new Set(['node_modules', 'uploads', '.agent-home', '.git']);

function isHtmlFile(dir, name) {
  if (!HTML_NAME.test(name)) return false;
  try {
    const st = fs.statSync(path.join(dir, name));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

function mtimeOf(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// Исходный index.html из Vite/CRA-проекта без сборки — не страница, а заглушка:
// он тянет несобранный /src/main.tsx, который браузер исполнить не может.
// Превью такой файл открывать не должно — иначе пользователь видит белый экран
// вместо понятного «проект ещё не собран».
const DEV_ENTRY_LIMIT = 256 * 1024;

function isRunnableHtml(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length > DEV_ENTRY_LIMIT) return true; // слишком большой — не проверяем, отдаём как есть
    const html = buf.toString('utf8');
    if (/@vite\/client/.test(html)) return false;
    if (/(?:src|href)=["'](?:\/?src\/)[^"']*\.(?:tsx|ts|jsx)(?:["'?])/i.test(html)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Which workspace HTML the in-product Preview panel should open.
 *
 * Priority:
 * 1. index.html at the workspace root (the agent's demo page).
 * 2. index.htm at the root.
 * 3. A built SPA: <root|project-folder>/(dist|build|out)/index.html — the
 *    newest wins, so a rebuild refreshes the preview automatically.
 * 4. A static project folder one level below the root: project/index.html.
 * 5. The only (or the newest) root-level HTML file — legacy behaviour for
 *    agent-written single-page demos like checkers.html.
 *
 * Unbuilt source entries (Vite dev html referencing /src/main.tsx) are skipped:
 * they cannot render without a build, and previewing them shows a white page.
 */
export function previewDocument(workspace) {
  const root = String(workspace || '');
  if (!root) return null;
  try {
    if (!fs.statSync(root).isDirectory()) return null;
  } catch {
    return null;
  }
  if (isHtmlFile(root, 'index.html') && isRunnableHtml(path.join(root, 'index.html'))) return 'index.html';
  if (isHtmlFile(root, 'index.htm') && isRunnableHtml(path.join(root, 'index.htm'))) return 'index.htm';

  // Собранные приложения и статические проекты.
  const candidates = [];
  const consider = (dir, relDir) => {
    const file = path.join(dir, 'index.html');
    if (!isHtmlFile(dir, 'index.html')) return;
    if (!isRunnableHtml(file)) return;
    candidates.push({ rel: `${relDir}index.html`, mtime: mtimeOf(file) });
  };
  for (const build of BUILD_DIRS) consider(path.join(root, build), `${build}/`);
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const name of names) {
    if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
    const dir = path.join(root, name);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    consider(dir, `${name}/`);
    for (const build of BUILD_DIRS) consider(path.join(dir, build), `${name}/${build}/`);
  }
  if (candidates.length) {
    candidates.sort((a, b) => b.mtime - a.mtime || a.rel.localeCompare(b.rel));
    return candidates[0].rel;
  }

  // Наследный фолбэк: единственный (или самый свежий) HTML в корне.
  const files = [];
  for (const name of names) {
    if (!isHtmlFile(root, name)) continue;
    if (!isRunnableHtml(path.join(root, name))) continue;
    files.push({ name, mtime: mtimeOf(path.join(root, name)) });
  }
  if (!files.length) return null;
  if (files.length === 1) return files[0].name;
  files.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  return files[0].name;
}

export function previewIsReady(workspace) {
  return Boolean(previewDocument(workspace));
}

/**
 * Собранные SPA (vite/webpack) ссылаются на ассеты абсолютными путями:
 * <script src="/assets/index-abc.js">. В iframe превью такой адрес уходит на
 * origin самого приложения и тянет ЧУЖИЕ файлы (или 404). Переписываем
 * абсолютные src/href/poster на пути относительно каталога страницы — они уже
 * наследуют маркер доступа из URL превью. Протокол-относительные (//host),
 * якорные (/#…) и одиночный «/» не трогаем.
 */
/**
 * Sandbox-iframe превью имеет непрозрачный origin, и обращение к
 * localStorage/sessionStorage там кидает SecurityError. Многие SPA (включая
 * сборки этого же проекта) трогают storage при старте — необработанный краш
 * оставлял серый экран вместо интерфейса. Подкладываем in-memory заглушку
 * ДО первого скрипта страницы: приложения загружаются, данные живут в
 * памяти вкладки (для превью этого достаточно).
 */
const PREVIEW_STORAGE_SHIM = `<script>(function(){
function makeStore(){var m={};return{setItem:function(k,v){m[String(k)]=String(v);},getItem:function(k){return Object.prototype.hasOwnProperty.call(m,String(k))?m[String(k)]:null;},removeItem:function(k){delete m[String(k)];},clear:function(){m={};},key:function(i){var ks=Object.keys(m);return i<ks.length?ks[i]:null;},get length(){return Object.keys(m).length;}};}
function shim(name){
try{var probe=window[name];if(probe&&typeof probe.getItem==='function'){probe.getItem('__pv_probe');return;}}catch(e){}
var store=null;
try{Object.defineProperty(window,name,{get:function(){if(!store)store=makeStore();return store;},configurable:true});}catch(e){}
}
shim('localStorage');shim('sessionStorage');
// document.cookie в sandbox-iframe тоже кидает SecurityError, а многие клиенты
// читают его для CSRF/темы — подкладываем in-memory банку cookie.
try{var c=document.cookie;}catch(e){var jar={};try{Object.defineProperty(document,'cookie',{get:function(){var out=[];for(var k in jar)out.push(k+'='+jar[k]);return out.join('; ');},set:function(v){var s=String(v||'');var eq=s.indexOf('=');var name=(eq>-1?s.slice(0,eq):s).trim();if(!name)return;jar[name]=eq>-1?s.slice(eq+1).split(';')[0]:'';},configurable:true});}catch(e2){}}
})();</script>`;

/**
 * Демо-режим API для превью. SPA в песочнице не может достучаться до
 * настоящего бэкенда (opaque origin + CORS), поэтому любой «настоящий» вход
 * обречён, и дальше экрана логина приложение не уходит. Перехватываем fetch
 * на наш /api-namespace и отвечаем правдоподобными демо-данными: вход
 * выполнен, один демо-чат, пустые сообщения. Так превью показывает весь
 * интерфейс, а не только форму входа. Реальные файлы превью
 * (/api/preview/<token>/~/...) и внешние URL не перехватываются.
 */
const PREVIEW_API_MOCK_SHIM = `<script>(function(){
if (window.__previewMock) return; window.__previewMock = true;
var DEMO_USER = { email: 'demo@preview.local', role: 'user' };
var NOW = Date.now();
var DEMO_CHAT = { id: 'ses_preview_demo', owner_id: DEMO_USER.email, title: 'Демо-чат', created_at: NOW, updated_at: NOW, sandbox_uid: 0 };
function J(obj, status) { return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'content-type': 'application/json' } }); }
function verb(init) { return String((init && init.method) || 'GET').toUpperCase(); }
function mockApi(url, init) {
  var u; try { u = new URL(url, location.href); } catch (e) { return null; }
  var p = u.pathname.replace(/\\/+$/, '');
  if (p.indexOf('/api/') !== 0) return null;
  if (/^\\/api\\/preview\\/[a-f0-9]{64}\\/~\\//.test(p)) return null;
  if (p === '/api/ui-config') return J({ systemInstruction: '', runtime: 'z-agent-native', version: '1.0.0' });
  if (p === '/api/global/health' || p === '/api/health') return J({ status: 'ok' });
  if (p === '/api/auth/me') return J({ status: 'success', user: DEMO_USER });
  if (p === '/api/auth/login' || p === '/api/auth/register' || p === '/api/auth/custom') return J({ status: 'success', user: DEMO_USER });
  if (p === '/api/auth/logout') return J({ status: 'success' });
  if (p === '/api/user/prefs') return J({});
  if (p === '/api/providers/models') return J({ models: [{ providerID: 'demo', providerName: 'Demo', modelID: 'demo-model', modelName: 'Демо-модель', free: true, source: 'discovered' }], providers: {}, generatedAt: NOW });
  if (p === '/api/provider-channels') return J({ providers: [{ id: 'demo', name: 'Demo', enabled: true }] });
  if (p.indexOf('/api/provider-channels/') === 0) return J({ models: [] });
  if (p === '/api/session' && verb(init) === 'GET') return J([DEMO_CHAT]);
  if (p === '/api/session' && verb(init) === 'POST') return J(DEMO_CHAT);
  if (/^\\/api\\/session\\/[^/]+\\/capabilities$/.test(p)) return J({ capabilities: { workspace: 'ready', preview: 'unavailable', terminal: 'unavailable' }, previewPath: null });
  if (/^\\/api\\/session\\/[^/]+\\/message$/.test(p)) return verb(init) === 'GET' ? J([]) : J({ ok: true });
  if (/^\\/api\\/session\\/[^/]+\\/queue$/.test(p)) return verb(init) === 'GET' ? J({ queue: [] }) : J({ ok: true });
  if (/^\\/api\\/session\\/[^/]+$/.test(p)) return verb(init) === 'DELETE' ? J({ ok: true }) : J(DEMO_CHAT);
  if (p === '/api/question') return J([]);
  if (p === '/api/file' || p === '/api/file/status' || p === '/api/workspace/tree') return J([]);
  return J({});
}
var originalFetch = window.fetch ? window.fetch.bind(window) : null;
window.fetch = function (input, init) {
  try {
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    var mocked = mockApi(url, init);
    if (mocked) return Promise.resolve(mocked);
  } catch (e) { /* fall through to real fetch */ }
  return originalFetch ? originalFetch(input, init) : Promise.reject(new Error('offline preview'));
};
// SSE в превью неоткуда взять: тишина вместо бесконечных реконнектов.
function FakeEventSource(url) { this.url = url; this.readyState = 0; this.__open = null; var self = this; setTimeout(function () { self.readyState = 1; try { if (self.__open) self.__open({ type: 'open' }); } catch (e) {} }, 40); }
FakeEventSource.prototype.addEventListener = function () {};
FakeEventSource.prototype.removeEventListener = function () {};
FakeEventSource.prototype.close = function () { this.readyState = 2; };
Object.defineProperty(FakeEventSource.prototype, 'onopen', { set: function (f) { this.__open = typeof f === 'function' ? f : null; }, get: function () { return this.__open; }, configurable: true });
Object.defineProperty(FakeEventSource.prototype, 'onmessage', { set: function () {}, get: function () { return null; }, configurable: true });
Object.defineProperty(FakeEventSource.prototype, 'onerror', { set: function () {}, get: function () { return null; }, configurable: true });
window.EventSource = FakeEventSource;
})();</script>`;

export function injectPreviewShims(html) {
  const doc = String(html);
  if (doc.includes('__pv_probe') || doc.includes('__previewMock')) return doc;
  if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head[^>]*>/i, (head) => `${head}${PREVIEW_STORAGE_SHIM}${PREVIEW_API_MOCK_SHIM}`);
  return PREVIEW_STORAGE_SHIM + PREVIEW_API_MOCK_SHIM + doc;
}

export function rewritePreviewHtml(html) {
  return injectPreviewShims(
    String(html).replace(
      /\b(src|href|poster)\s*=\s*(["'])(\/(?!\/|#|["'])[^"']*)\2/gi,
      (all, attr, quote, value) => `${attr}=${quote}${String(value).slice(1)}${quote}`,
    ),
  );
}
