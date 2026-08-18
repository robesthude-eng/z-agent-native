import fs from 'node:fs';
import path from 'node:path';

const MANIFEST_VERSION = 1;
const SAFE_ENV_KEYS = new Set([
  'JAVA_HOME', 'GRADLE_HOME', 'VIRTUAL_ENV', 'ANDROID_HOME', 'ANDROID_SDK_ROOT',
]);
const ANDROID_COMMANDLINE_TOOLS_VERSION = '15859902';
const ANDROID_COMMANDLINE_TOOLS_SHA256 = '4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583';

/**
 * Operator-pinned artifact checksums, as {"java:21":"<sha256>","gradle:8.14.5":"<sha256>"}.
 *
 * Publishers host the checksum next to the artifact, so whoever can serve a
 * malicious archive can serve a matching checksum file too. A pin here is the
 * only real integrity anchor; without one the download falls back to the
 * published checksum, which only detects corruption in transit.
 */
const TOOLCHAIN_SHA256_PINS = (() => {
  try { return JSON.parse(process.env.Z_AGENT_TOOLCHAIN_SHA256 || '{}') || {}; }
  catch { return {}; }
})();

function pinnedChecksum(kind, version) {
  const value = String(TOOLCHAIN_SHA256_PINS[`${kind}:${version}`] || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(value) ? value : '';
}

function agentHome(root) { return path.join(root, '.agent-home'); }
function manifestPath(root) { return path.join(agentHome(root), 'environment.json'); }
function slash(value) { return String(value).split(path.sep).join('/'); }
function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }

function insideRoot(root, value) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(String(value || ''));
  return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function blankManifest() {
  return { version: MANIFEST_VERSION, env: {}, pathPrepend: [], installed: {} };
}

export function readEnvironmentManifest(root) {
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath(root), 'utf8'));
    if (!raw || raw.version !== MANIFEST_VERSION) return blankManifest();
    const env = {};
    for (const [key, value] of Object.entries(raw.env || {})) {
      if (!SAFE_ENV_KEYS.has(key) || typeof value !== 'string' || !insideRoot(root, value)) continue;
      env[key] = value;
    }
    const pathPrepend = Array.isArray(raw.pathPrepend)
      ? raw.pathPrepend.filter((value) => typeof value === 'string' && insideRoot(root, value))
      : [];
    return {
      version: MANIFEST_VERSION,
      env,
      pathPrepend: unique(pathPrepend),
      installed: raw.installed && typeof raw.installed === 'object' ? raw.installed : {},
    };
  } catch {
    return blankManifest();
  }
}

export function managedShellEnvironment(root, base = {}) {
  const home = agentHome(root);
  const manifest = readEnvironmentManifest(root);
  const basePath = String(base.PATH || process.env.PATH || '/usr/local/bin:/usr/bin:/bin');
  const defaults = [
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
  ];
  return {
    ...base,
    ...manifest.env,
    PATH: unique([...manifest.pathPrepend, ...defaults]).join(':') + `:${basePath}`,
    HOME: home,
    USER: 'agent',
    GRADLE_USER_HOME: path.join(home, 'gradle'),
    ANDROID_USER_HOME: path.join(home, 'android-user'),
    XDG_CACHE_HOME: path.join(home, 'cache'),
    PIP_CACHE_DIR: path.join(home, 'cache', 'pip'),
    NPM_CONFIG_CACHE: path.join(home, 'cache', 'npm'),
  };
}

// The previous check only rejected leading dashes, whitespace and control
// characters, so specs such as a git+https VCS URL or "pkg@file:/tmp/x" were
// handed straight to the installer: arbitrary code execution at install time.
// Only plain name[extras][version-constraint] specs are accepted now.
const PIP_PACKAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9,._-]+\])?(?:(?:==|>=|<=|~=|!=|>|<)[A-Za-z0-9._*+!-]+)?$/;
const NPM_PACKAGE_PATTERN = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9._^~><=*+-]+)?$/;
// sdkmanager coordinates are semicolon separated: platforms;android-36
const SDK_PACKAGE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*(?:;[A-Za-z0-9][A-Za-z0-9._+-]*)*$/;
const PACKAGE_PATTERNS = {
  pip: PIP_PACKAGE_PATTERN,
  python: PIP_PACKAGE_PATTERN,
  npm: NPM_PACKAGE_PATTERN,
  node: NPM_PACKAGE_PATTERN,
  android: SDK_PACKAGE_PATTERN,
  'android sdk': SDK_PACKAGE_PATTERN,
};

function safePackages(values, kind) {
  const rows = Array.isArray(values) ? values.slice(0, 30) : [];
  const pattern = PACKAGE_PATTERNS[String(kind).toLowerCase()] || PIP_PACKAGE_PATTERN;
  return rows.map((value) => {
    const text = String(value || '').trim();
    if (!text || text.length > 200 || !pattern.test(text)) {
      throw new Error(`Unsafe ${kind} package spec: ${JSON.stringify(text)}`);
    }
    return text;
  });
}

function javaArch() {
  if (process.arch === 'x64') return 'x64';
  if (process.arch === 'arm64') return 'aarch64';
  throw new Error(`Java provisioning is not supported on ${process.arch}`);
}

function javaPlan(root, input) {
  const version = String(input?.version || '21').trim();
  if (!/^\d{1,2}$/.test(version) || Number(version) < 8 || Number(version) > 99) throw new Error('Java version must be a major version such as 17, 21, or 25');
  const home = agentHome(root);
  const install = path.join(home, 'toolchains', 'java', version);
  const downloads = path.join(home, 'downloads');
  const archive = path.join(downloads, `temurin-${version}.tar.gz`);
  const api = `https://api.adoptium.net/v3/binary/latest/${version}/ga/linux/${javaArch()}/jdk/hotspot/normal/eclipse`;
  const script = `set -euo pipefail\nmkdir -p ${shellQuote(downloads)} ${shellQuote(path.dirname(install))}\nif [ ! -x ${shellQuote(path.join(install, 'bin', 'java'))} ]; then\n  API_URL=${shellQuote(api)}\n  FETCH_URL="$(curl -fsS --proto '=https' --tlsv1.2 -o /dev/null -w '%{redirect_url}' "$API_URL")"\n  test -n "$FETCH_URL"\n  case "$FETCH_URL" in https://*) ;; *) echo 'Refusing non-HTTPS toolchain download' >&2; exit 1;; esac\n  curl -fL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 1 "$FETCH_URL" -o ${shellQuote(archive)}\n  EXPECTED=${shellQuote(pinnedChecksum('java', version))}\n  if [ -z "$EXPECTED" ]; then EXPECTED="$(curl -fsSL --proto '=https' --tlsv1.2 "$FETCH_URL.sha256.txt" | awk 'NR==1 {print $1}')"; fi\n  test -n "$EXPECTED"\n  printf '%s  %s\\n' "$EXPECTED" ${shellQuote(archive)} | sha256sum -c -\n  TMP=${shellQuote(`${install}.tmp`)}\n  rm -rf "$TMP" ${shellQuote(install)}\n  mkdir -p "$TMP"\n  tar -xzf ${shellQuote(archive)} -C "$TMP" --strip-components=1\n  test -x "$TMP/bin/java"\n  mv "$TMP" ${shellQuote(install)}\nfi\n${shellQuote(path.join(install, 'bin', 'java'))} -version\n${shellQuote(path.join(install, 'bin', 'javac'))} -version`;
  return {
    kind: 'java', title: `Java ${version}`, script,
    env: { JAVA_HOME: install }, pathPrepend: [path.join(install, 'bin')],
    installedKey: `java:${version}`, installedValue: { kind: 'java', version, source: 'Eclipse Temurin / Adoptium' },
  };
}

function pythonPlan(root, input) {
  const packages = safePackages(input?.packages, 'Python');
  const home = agentHome(root);
  const venv = path.join(home, 'venvs', 'python');
  const python = path.join(venv, 'bin', 'python');
  const packageArgs = packages.map(shellQuote).join(' ');
  const script = `set -euo pipefail\ncommand -v python3 >/dev/null 2>&1 || { echo 'python3 is unavailable in the runtime image' >&2; exit 42; }\nmkdir -p ${shellQuote(path.dirname(venv))}\nif [ ! -x ${shellQuote(python)} ]; then python3 -m venv ${shellQuote(venv)}; fi\n${shellQuote(python)} -m pip --version${packages.length ? `\n${shellQuote(python)} -m pip install --disable-pip-version-check --no-input ${packageArgs}` : ''}\n${shellQuote(python)} --version`;
  return {
    kind: 'python', title: packages.length ? `Python environment: ${packages.join(', ')}` : 'Python environment', script,
    env: { VIRTUAL_ENV: venv }, pathPrepend: [path.join(venv, 'bin')],
    installedKey: 'python', installedValue: { kind: 'python', packages },
  };
}

function gradlePlan(root, input) {
  const version = String(input?.version || '8.14.5').trim();
  if (!/^\d+(?:\.\d+){1,2}$/.test(version)) throw new Error('Gradle version must look like 8.14.5 or 9.6.1');
  const home = agentHome(root);
  const install = path.join(home, 'toolchains', 'gradle', version);
  const downloads = path.join(home, 'downloads');
  const archive = path.join(downloads, `gradle-${version}-bin.zip`);
  const url = `https://services.gradle.org/distributions/gradle-${version}-bin.zip`;
  const script = `set -euo pipefail\ncommand -v java >/dev/null 2>&1 || { echo 'Java is required; provision kind=java first' >&2; exit 42; }\nmkdir -p ${shellQuote(downloads)} ${shellQuote(path.dirname(install))}\nif [ ! -x ${shellQuote(path.join(install, 'bin', 'gradle'))} ]; then\n  URL=${shellQuote(url)}\n  case "$URL" in https://*) ;; *) echo 'Refusing non-HTTPS toolchain download' >&2; exit 1;; esac\n  curl -fL --proto '=https' --tlsv1.2 --retry 3 --retry-delay 1 "$URL" -o ${shellQuote(archive)}\n  EXPECTED=${shellQuote(pinnedChecksum('gradle', version))}\n  if [ -z "$EXPECTED" ]; then EXPECTED="$(curl -fsSL --proto '=https' --tlsv1.2 "$URL.sha256" | tr -d '[:space:]')"; fi\n  test -n "$EXPECTED"\n  printf '%s  %s\\n' "$EXPECTED" ${shellQuote(archive)} | sha256sum -c -\n  TMP=${shellQuote(`${install}.tmp`)}\n  rm -rf "$TMP" ${shellQuote(install)}\n  mkdir -p "$TMP"\n  unzip -q ${shellQuote(archive)} -d "$TMP"\n  test -x "$TMP/gradle-${version}/bin/gradle"\n  mv "$TMP/gradle-${version}" ${shellQuote(install)}\n  rm -rf "$TMP"\nfi\n${shellQuote(path.join(install, 'bin', 'gradle'))} --version`;
  return {
    kind: 'gradle', title: `Gradle ${version}`, script,
    env: { GRADLE_HOME: install }, pathPrepend: [path.join(install, 'bin')],
    installedKey: `gradle:${version}`, installedValue: { kind: 'gradle', version, source: 'services.gradle.org' },
  };
}

function androidPlan(root, input) {
  const packages = safePackages(input?.packages, 'Android SDK');
  if (packages.some((value) => !/^[A-Za-z0-9._;:+-]+$/.test(value))) throw new Error('Android SDK package IDs may contain only letters, digits, dot, underscore, semicolon, colon, plus and dash');
  const acceptLicenses = input?.acceptLicenses === true;
  if (packages.length && !acceptLicenses) throw new Error('Installing Android SDK packages requires acceptLicenses=true so the permission request explicitly shows license acceptance');
  const home = agentHome(root);
  const sdk = path.join(home, 'toolchains', 'android-sdk');
  const downloads = path.join(home, 'downloads');
  const archive = path.join(downloads, `android-commandlinetools-${ANDROID_COMMANDLINE_TOOLS_VERSION}.zip`);
  const url = `https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_COMMANDLINE_TOOLS_VERSION}_latest.zip`;
  const sdkmanager = path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager');
  const packageArgs = packages.map(shellQuote).join(' ');
  const licenseBlock = acceptLicenses
    ? `\nset +o pipefail\nyes | ${shellQuote(sdkmanager)} --sdk_root=${shellQuote(sdk)} --licenses >/dev/null\nLICENSE_STATUS="${'${PIPESTATUS[1]}'}"\nset -o pipefail\ntest "$LICENSE_STATUS" -eq 0`
    : '';
  const packageBlock = packages.length ? `\n${shellQuote(sdkmanager)} --sdk_root=${shellQuote(sdk)} ${packageArgs}` : '';
  const script = `set -euo pipefail\ncommand -v java >/dev/null 2>&1 || { echo 'Java is required; provision kind=java first' >&2; exit 42; }\nmkdir -p ${shellQuote(downloads)} ${shellQuote(path.join(sdk, 'cmdline-tools'))}\nif [ ! -x ${shellQuote(sdkmanager)} ]; then\n  curl -fL --retry 3 --retry-delay 1 ${shellQuote(url)} -o ${shellQuote(archive)}\n  printf '%s  %s\\n' ${shellQuote(ANDROID_COMMANDLINE_TOOLS_SHA256)} ${shellQuote(archive)} | sha256sum -c -\n  TMP=${shellQuote(path.join(home, 'toolchains', 'android-cli.tmp'))}\n  rm -rf "$TMP" ${shellQuote(path.join(sdk, 'cmdline-tools', 'latest'))}\n  mkdir -p "$TMP"\n  unzip -q ${shellQuote(archive)} -d "$TMP"\n  test -x "$TMP/cmdline-tools/bin/sdkmanager"\n  mv "$TMP/cmdline-tools" ${shellQuote(path.join(sdk, 'cmdline-tools', 'latest'))}\n  rm -rf "$TMP"\nfi${licenseBlock}${packageBlock}\n${shellQuote(sdkmanager)} --sdk_root=${shellQuote(sdk)} --version`;
  return {
    kind: 'android', title: packages.length ? `Android SDK: ${packages.join(', ')}` : 'Android SDK command-line tools', script,
    env: { ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk },
    pathPrepend: [path.join(sdk, 'platform-tools'), path.join(sdk, 'cmdline-tools', 'latest', 'bin')],
    installedKey: 'android', installedValue: { kind: 'android', commandlineTools: ANDROID_COMMANDLINE_TOOLS_VERSION, packages },
  };
}

export function prepareEnvironmentRequirement(root, input = {}) {
  const kind = String(input?.kind || '').trim().toLowerCase();
  if (kind === 'python') return pythonPlan(root, input);
  if (kind === 'java') return javaPlan(root, input);
  if (kind === 'gradle') return gradlePlan(root, input);
  if (kind === 'android') return androidPlan(root, input);
  throw new Error('Unsupported environment kind. Use python, java, gradle, or android.');
}

export function commitEnvironmentRequirement(root, plan) {
  const home = agentHome(root);
  fs.mkdirSync(home, { recursive: true });
  const manifest = readEnvironmentManifest(root);
  manifest.env = { ...manifest.env, ...(plan.env || {}) };
  manifest.pathPrepend = unique([...(plan.pathPrepend || []), ...manifest.pathPrepend]);
  manifest.installed = {
    ...manifest.installed,
    [plan.installedKey]: { ...(plan.installedValue || {}), updatedAt: new Date().toISOString() },
  };
  const target = manifestPath(root);
  const tmp = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, target);
  return manifest;
}

export function describeManagedEnvironment(root) {
  const manifest = readEnvironmentManifest(root);
  const installed = Object.entries(manifest.installed || {}).map(([key, value]) => ({ key, ...value }));
  return {
    home: slash(agentHome(root)),
    env: manifest.env,
    pathPrepend: manifest.pathPrepend.map(slash),
    installed,
  };
}
