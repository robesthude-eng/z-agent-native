import fs from 'node:fs';
import path from 'node:path';

const IGNORED_DIRS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.cache', '.agent-home',
  '.venv', 'venv', '__pycache__', 'target', '.turbo', '.parcel-cache', '.pytest_cache',
]);

const LANGUAGE_BY_EXT = new Map([
  ['.js', 'JavaScript'], ['.jsx', 'JavaScript'], ['.mjs', 'JavaScript'], ['.cjs', 'JavaScript'],
  ['.ts', 'TypeScript'], ['.tsx', 'TypeScript'], ['.mts', 'TypeScript'], ['.cts', 'TypeScript'],
  ['.py', 'Python'], ['.go', 'Go'], ['.rs', 'Rust'], ['.java', 'Java'], ['.kt', 'Kotlin'],
  ['.rb', 'Ruby'], ['.php', 'PHP'], ['.cs', 'C#'], ['.cpp', 'C++'], ['.cc', 'C++'], ['.c', 'C'],
  ['.h', 'C/C++ Header'], ['.hpp', 'C++ Header'], ['.swift', 'Swift'], ['.vue', 'Vue'], ['.svelte', 'Svelte'],
  ['.sql', 'SQL'], ['.sh', 'Shell'], ['.bash', 'Shell'], ['.css', 'CSS'], ['.scss', 'SCSS'],
  ['.html', 'HTML'], ['.md', 'Markdown'], ['.json', 'JSON'], ['.yaml', 'YAML'], ['.yml', 'YAML'],
  ['.toml', 'TOML'], ['.xml', 'XML'],
]);

const MANIFEST_NAMES = new Set([
  'package.json', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'poetry.lock',
  'Cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile',
  'composer.json', 'mix.exs', 'deno.json', 'deno.jsonc', 'bun.lock', 'bun.lockb',
]);

const CONFIG_NAMES = new Set([
  'tsconfig.json', 'jsconfig.json', 'vite.config.js', 'vite.config.mjs', 'vite.config.ts',
  'next.config.js', 'next.config.mjs', 'next.config.ts', 'eslint.config.js', 'eslint.config.mjs',
  'biome.json', 'biome.jsonc', 'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
  'Makefile', 'Justfile', '.github', '.gitlab-ci.yml', 'playwright.config.ts', 'vitest.config.ts',
]);

const SOURCE_EXTS = new Set([
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.py', '.go', '.rs',
  '.java', '.kt', '.rb', '.php', '.cs', '.cpp', '.cc', '.c', '.h', '.hpp', '.swift', '.vue', '.svelte',
]);

const IMPORT_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const MAX_SCAN_BYTES = 160 * 1024;

function slash(value) { return value.split(path.sep).join('/'); }
function rel(root, full) { return slash(path.relative(root, full)) || '.'; }

function readSmall(full, maxBytes = MAX_SCAN_BYTES) {
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

function walkFiles(root, scope, options = {}) {
  const maxFiles = Math.min(Math.max(Number(options.maxFiles) || 2500, 100), 8000);
  const maxDepth = Math.min(Math.max(Number(options.maxDepth) || 12, 1), 20);
  const files = [];
  let truncated = false;

  function visit(dir, depth) {
    if (truncated || depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (truncated) break;
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      try { size = fs.statSync(full).size; } catch {}
      files.push({ full, path: rel(root, full), size, ext: path.extname(entry.name).toLowerCase(), name: entry.name });
      if (files.length >= maxFiles) truncated = true;
    }
  }

  const st = fs.statSync(scope);
  if (st.isFile()) {
    files.push({ full: scope, path: rel(root, scope), size: st.size, ext: path.extname(scope).toLowerCase(), name: path.basename(scope) });
  } else {
    visit(scope, 0);
  }
  return { files, truncated, maxFiles };
}

function packageSummary(_root, files) {
  const pkg = files.find((file) => file.path === 'package.json');
  if (!pkg) return null;
  const text = readSmall(pkg.full, 512 * 1024);
  if (!text) return null;
  try {
    const json = JSON.parse(text);
    const scripts = Object.fromEntries(Object.entries(json.scripts || {}).slice(0, 30).map(([key, value]) => [key, String(value)]));
    const declaredEntrypoints = [json.main, json.module, json.browser]
      .flatMap((value) => typeof value === 'string' ? [value] : [])
      .map((value) => slash(value.replace(/^\.\//, '')));
    if (typeof json.bin === 'string') declaredEntrypoints.push(slash(json.bin.replace(/^\.\//, '')));
    else if (json.bin && typeof json.bin === 'object') {
      for (const value of Object.values(json.bin)) if (typeof value === 'string') declaredEntrypoints.push(slash(value.replace(/^\.\//, '')));
    }
    return {
      name: typeof json.name === 'string' ? json.name : null,
      type: typeof json.type === 'string' ? json.type : null,
      packageManager: typeof json.packageManager === 'string' ? json.packageManager : null,
      scripts,
      dependencyCount: Object.keys(json.dependencies || {}).length,
      devDependencyCount: Object.keys(json.devDependencies || {}).length,
      declaredEntrypoints: [...new Set(declaredEntrypoints)],
    };
  } catch {
    return { invalid: true };
  }
}

function languageSummary(files) {
  const counts = new Map();
  for (const file of files) {
    const language = LANGUAGE_BY_EXT.get(file.ext);
    if (!language) continue;
    const row = counts.get(language) || { language, files: 0, bytes: 0 };
    row.files += 1;
    row.bytes += file.size;
    counts.set(language, row);
  }
  return [...counts.values()].sort((a, b) => b.files - a.files || b.bytes - a.bytes).slice(0, 14);
}

function topDirectories(files) {
  const counts = new Map();
  for (const file of files) {
    const top = file.path.includes('/') ? file.path.split('/')[0] : '.';
    const row = counts.get(top) || { path: top, files: 0, bytes: 0 };
    row.files += 1;
    row.bytes += file.size;
    counts.set(top, row);
  }
  return [...counts.values()].sort((a, b) => b.files - a.files || b.bytes - a.bytes).slice(0, 16);
}

function looksLikeTest(filePath) {
  return /(^|\/)(?:test|tests|__tests__|spec)(\/|$)/i.test(filePath)
    || /(?:\.test|\.spec)\.[^./]+$/i.test(filePath)
    || /_test\.(?:go|py)$/i.test(filePath)
    || /^test_.+\.py$/i.test(path.basename(filePath));
}

function entrypointScore(filePath) {
  const lower = filePath.toLowerCase();
  const base = path.posix.basename(lower);
  let score = 0;
  if (/^(?:index|main|app|server|cli)\.(?:[cm]?[jt]sx?|py|go|rs)$/.test(base)) score += 6;
  if (/^(?:src|server|app|cmd|lib)\//.test(lower)) score += 2;
  if (/^(?:server\/index|src\/main|src\/index|src\/app|app\/main|cmd\/)/.test(lower)) score += 4;
  if (looksLikeTest(lower)) score -= 6;
  if (/\.d\.ts$/.test(lower)) score -= 5;
  return score;
}

function candidateEntrypoints(files, pkg) {
  const declared = new Set(pkg?.declaredEntrypoints || []);
  const rows = [];
  for (const file of files) {
    let score = entrypointScore(file.path);
    if (declared.has(file.path)) score += 10;
    if (score > 0) rows.push({ path: file.path, score, declared: declared.has(file.path) });
  }
  return rows.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 20);
}

function symbolNames(text, ext) {
  const out = [];
  const add = (kind, name) => {
    if (!name || out.some((item) => item.name === name && item.kind === kind)) return;
    out.push({ kind, name });
  };
  const patterns = [];
  if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'].includes(ext)) {
    patterns.push(['function', /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g]);
    patterns.push(['class', /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/g]);
    patterns.push(['export', /(?:^|\n)\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g]);
  } else if (ext === '.py') {
    patterns.push(['function', /(?:^|\n)\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/g]);
    patterns.push(['class', /(?:^|\n)\s*class\s+([A-Za-z_]\w*)/g]);
  } else if (ext === '.go') {
    patterns.push(['function', /(?:^|\n)\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g]);
    patterns.push(['type', /(?:^|\n)\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)\b/g]);
  } else if (ext === '.rs') {
    patterns.push(['function', /(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/g]);
    patterns.push(['type', /(?:^|\n)\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/g]);
  }
  for (const [kind, rx] of patterns) {
    let match;
    while ((match = rx.exec(text)) && out.length < 30) add(kind, match[1]);
  }
  return out;
}

function collectSymbols(files, maxFiles = 240, maxSymbolsPerFile = 10) {
  if (maxSymbolsPerFile <= 0) return [];
  const rows = [];
  for (const file of files) {
    if (!SOURCE_EXTS.has(file.ext) || file.size > MAX_SCAN_BYTES || looksLikeTest(file.path)) continue;
    const text = readSmall(file.full);
    if (!text) continue;
    const symbols = symbolNames(text, file.ext).slice(0, maxSymbolsPerFile);
    if (symbols.length) rows.push({ path: file.path, symbols });
    if (rows.length >= maxFiles) break;
  }
  return rows;
}

function resolveRelativeImport(root, importer, spec, fileSet) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(path.join(root, importer)), spec);
  const candidates = [base, ...IMPORT_EXTS.map((ext) => `${base}${ext}`), ...IMPORT_EXTS.map((ext) => path.join(base, `index${ext}`))];
  for (const full of candidates) {
    const candidate = rel(root, full);
    if (fileSet.has(candidate)) return candidate;
  }
  return null;
}

function importHubs(root, files) {
  const fileSet = new Set(files.map((file) => file.path));
  const inbound = new Map();
  let scanned = 0;
  for (const file of files) {
    if (!['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'].includes(file.ext) || file.size > MAX_SCAN_BYTES) continue;
    const text = readSmall(file.full);
    if (!text) continue;
    scanned += 1;
    const specs = [];
    const importRx = /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;
    const requireRx = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
    let match;
    while ((match = importRx.exec(text))) specs.push(match[1]);
    while ((match = requireRx.exec(text))) specs.push(match[1]);
    for (const spec of specs) {
      const target = resolveRelativeImport(root, file.path, spec, fileSet);
      if (target) inbound.set(target, (inbound.get(target) || 0) + 1);
    }
    if (scanned >= 500) break;
  }
  return [...inbound.entries()]
    .map(([filePath, count]) => ({ path: filePath, inboundImports: count }))
    .sort((a, b) => b.inboundImports - a.inboundImports || a.path.localeCompare(b.path))
    .slice(0, 20);
}

function manifests(files) {
  return files.filter((file) => MANIFEST_NAMES.has(file.name)).map((file) => file.path).slice(0, 30);
}

function configs(files) {
  const out = [];
  for (const file of files) {
    if (CONFIG_NAMES.has(file.name) || file.path.startsWith('.github/workflows/')) out.push(file.path);
    if (out.length >= 40) break;
  }
  return out;
}

export function buildRepoMap(root, scope = root, options = {}) {
  const scan = walkFiles(root, scope, options);
  const pkg = packageSummary(root, scan.files);
  const maxSymbolsPerFile = Math.min(Math.max(Number(options.maxSymbolsPerFile) || 8, 0), 20);
  return {
    scope: rel(root, scope),
    fileCount: scan.files.length,
    truncated: scan.truncated,
    maxFiles: scan.maxFiles,
    languages: languageSummary(scan.files),
    topDirectories: topDirectories(scan.files),
    manifests: manifests(scan.files),
    configs: configs(scan.files),
    package: pkg,
    entrypoints: candidateEntrypoints(scan.files, pkg),
    importHubs: importHubs(root, scan.files),
    symbolFiles: collectSymbols(scan.files, 240, maxSymbolsPerFile),
    tests: scan.files.filter((file) => looksLikeTest(file.path)).map((file) => file.path).slice(0, 80),
  };
}

function fmtList(rows, formatter, empty = '(none detected)') {
  return rows?.length ? rows.map(formatter).join('\n') : empty;
}

export function formatRepoMap(map) {
  const lines = [];
  lines.push(`[Repository map: ${map.scope || '.'}]`);
  lines.push(`Files scanned: ${map.fileCount}${map.truncated ? ` (capped at ${map.maxFiles})` : ''}`);
  lines.push('');
  lines.push('Languages:');
  lines.push(fmtList(map.languages, (row) => `- ${row.language}: ${row.files} files, ${row.bytes} bytes`));
  lines.push('');
  lines.push('Top-level areas:');
  lines.push(fmtList(map.topDirectories, (row) => `- ${row.path}: ${row.files} files`));
  lines.push('');
  lines.push(`Manifests: ${map.manifests?.length ? map.manifests.join(', ') : '(none detected)'}`);
  lines.push(`Configs/CI: ${map.configs?.length ? map.configs.join(', ') : '(none detected)'}`);
  if (map.package) {
    lines.push('');
    lines.push('package.json:');
    if (map.package.name) lines.push(`- name: ${map.package.name}`);
    if (map.package.packageManager) lines.push(`- packageManager: ${map.package.packageManager}`);
    lines.push(`- dependencies: ${map.package.dependencyCount || 0}; devDependencies: ${map.package.devDependencyCount || 0}`);
    const scripts = Object.entries(map.package.scripts || {});
    if (scripts.length) lines.push(`- scripts: ${scripts.map(([name, command]) => `${name}=${command}`).join(' | ')}`);
  }
  lines.push('');
  lines.push('Likely entrypoints:');
  lines.push(fmtList(map.entrypoints, (row) => `- ${row.path}${row.declared ? ' (declared)' : ''}`));
  lines.push('');
  lines.push('Import hubs:');
  lines.push(fmtList(map.importHubs, (row) => `- ${row.path}: ${row.inboundImports} inbound relative imports`));
  lines.push('');
  lines.push('High-signal symbols:');
  lines.push(fmtList(map.symbolFiles?.slice(0, 60), (row) => `- ${row.path}: ${row.symbols.map((symbol) => `${symbol.kind} ${symbol.name}`).join(', ')}`));
  lines.push('');
  lines.push(`Tests (${map.tests?.length || 0} shown): ${map.tests?.length ? map.tests.join(', ') : '(none detected)'}`);
  return lines.join('\n');
}
