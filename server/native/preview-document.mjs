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
export function rewritePreviewHtml(html) {
  return String(html).replace(
    /\b(src|href|poster)\s*=\s*(["'])(\/(?!\/|#|["'])[^"']*)\2/gi,
    (all, attr, quote, value) => `${attr}=${quote}${String(value).slice(1)}${quote}`,
  );
}
