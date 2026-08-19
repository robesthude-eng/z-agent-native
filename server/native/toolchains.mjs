import path from 'node:path';
import { CLOUD_TOOLCHAIN_KINDS, prepareCloudToolchainRequirement } from './cloud-toolchains.mjs';

export const EXTENDED_TOOLCHAIN_KINDS = ['go', 'rust', 'node', 'maven', 'flutter', 'kubectl', 'terraform', ...CLOUD_TOOLCHAIN_KINDS, 'portable'];

function agentHome(root) { return path.join(root, '.agent-home'); }
function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }
function slug(value) { return String(value || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'default'; }

function linuxArch(kind) {
  if (process.arch === 'x64') {
    if (kind === 'rust') return 'x86_64-unknown-linux-gnu';
    if (kind === 'go' || kind === 'kubectl' || kind === 'terraform') return 'amd64';
    if (kind === 'node') return 'x64';
    return 'x64';
  }
  if (process.arch === 'arm64') {
    if (kind === 'rust') return 'aarch64-unknown-linux-gnu';
    if (kind === 'go' || kind === 'kubectl' || kind === 'terraform') return 'arm64';
    if (kind === 'node') return 'arm64';
    return 'arm64';
  }
  throw new Error(`${kind} provisioning is not supported on ${process.arch}`);
}

function safeVersion(value, fallback, label, pattern = /^[A-Za-z0-9._+-]+$/) {
  const text = String(value || fallback).trim();
  if (!text || text.length > 80 || !pattern.test(text)) throw new Error(`Invalid ${label} version: ${JSON.stringify(text)}`);
  return text;
}

function commonDirs(root) {
  const home = agentHome(root);
  return { home, downloads: path.join(home, 'downloads'), toolchains: path.join(home, 'toolchains') };
}

function goPlan(root, input) {
  const requested = safeVersion(input?.version, 'latest', 'Go', /^(?:latest|\d+\.\d+(?:\.\d+)?)$/);
  const arch = linuxArch('go');
  const { downloads, toolchains } = commonDirs(root);
  const install = path.join(toolchains, 'go', slug(requested));
  const archive = path.join(downloads, `go-${slug(requested)}.tar.gz`);
  const metadataUrl = requested === 'latest' ? 'https://go.dev/dl/?mode=json' : 'https://go.dev/dl/?mode=json&include=all';
  const resolver = requested === 'latest'
    ? "print(data[0]['version'].removeprefix('go'))"
    : `target=${JSON.stringify(requested)}\nmatch=next((r for r in data if r.get('version') == 'go'+target), None)\nassert match, 'Go release not found: '+target\nprint(target)`;
  const script = `set -euo pipefail\nmkdir -p ${shellQuote(downloads)} ${shellQuote(path.dirname(install))}\nif [ ! -x ${shellQuote(path.join(install, 'bin', 'go'))} ]; then\n  META="$(curl -fsSL ${shellQuote(metadataUrl)})"\n  VERSION="$(printf '%s' "$META" | python3 -c ${shellQuote(`import json,sys\ndata=json.load(sys.stdin)\n${resolver}`)})"\n  FILE="go$VERSION.linux-${arch}.tar.gz"\n  SHA="$(printf '%s' "$META" | VERSION="$VERSION" FILE="$FILE" python3 -c ${shellQuote("import json,os,sys\ndata=json.load(sys.stdin)\nt='go'+os.environ['VERSION']; f=os.environ['FILE']\nr=next((x for x in data if x.get('version')==t), None)\nassert r, 'Go release metadata missing'\nm=next((x for x in r.get('files',[]) if x.get('filename')==f), None)\nassert m and m.get('sha256'), 'Go checksum metadata missing'\nprint(m['sha256'])")})"\n  URL="https://go.dev/dl/$FILE"\n  curl -fL --retry 3 --retry-delay 1 "$URL" -o ${shellQuote(archive)}\n  printf '%s  %s\\n' "$SHA" ${shellQuote(archive)} | sha256sum -c -\n  TMP=${shellQuote(`${install}.tmp`)}\n  rm -rf "$TMP" ${shellQuote(install)}\n  mkdir -p "$TMP"\n  tar -xzf ${shellQuote(archive)} -C "$TMP"\n  test -x "$TMP/go/bin/go"\n  mv "$TMP/go" ${shellQuote(install)}\n  rm -rf "$TMP"\nfi\n${shellQuote(path.join(install, 'bin', 'go'))} version`;
  return {
    kind: 'go', title: `Go ${requested}`, script, env: {}, pathPrepend: [path.join(install, 'bin')],
    installedKey: `go:${requested}`, installedValue: { kind: 'go', version: requested, source: 'go.dev' },
  };
}

function rustPlan(root, input) {
  const toolchain = safeVersion(input?.version, 'stable', 'Rust', /^(?:stable|beta|nightly|\d+\.\d+(?:\.\d+)?)$/);
  const target = linuxArch('rust');
  const { home, downloads } = commonDirs(root);
  const cargoHome = path.join(home, '.cargo');
  const rustupHome = path.join(home, '.rustup');
  const installer = path.join(downloads, `rustup-init-${target}`);
  const url = `https://static.rust-lang.org/rustup/dist/${target}/rustup-init`;
  const script = `set -euo pipefail\nmkdir -p ${shellQuote(downloads)} ${shellQuote(cargoHome)} ${shellQuote(rustupHome)}\nif [ ! -x ${shellQuote(path.join(cargoHome, 'bin', 'rustup'))} ]; then\n  curl -fL --retry 3 --retry-delay 1 ${shellQuote(url)} -o ${shellQuote(installer)}\n  EXPECTED="$(curl -fsSL ${shellQuote(`${url}.sha256`)} | awk 'NR==1 {print $1}')"\n  test -n "$EXPECTED"\n  printf '%s  %s\\n' "$EXPECTED" ${shellQuote(installer)} | sha256sum -c -\n  chmod 0700 ${shellQuote(installer)}\n  CARGO_HOME=${shellQuote(cargoHome)} RUSTUP_HOME=${shellQuote(rustupHome)} ${shellQuote(installer)} -y --no-modify-path --profile minimal --default-toolchain ${shellQuote(toolchain)}\nelse\n  CARGO_HOME=${shellQuote(cargoHome)} RUSTUP_HOME=${shellQuote(rustupHome)} ${shellQuote(path.join(cargoHome, 'bin', 'rustup'))} toolchain install ${shellQuote(toolchain)} --profile minimal\n  CARGO_HOME=${shellQuote(cargoHome)} RUSTUP_HOME=${shellQuote(rustupHome)} ${shellQuote(path.join(cargoHome, 'bin', 'rustup'))} default ${shellQuote(toolchain)}\nfi\nCARGO_HOME=${shellQuote(cargoHome)} RUSTUP_HOME=${shellQuote(rustupHome)} ${shellQuote(path.join(cargoHome, 'bin', 'rustc'))} --version\nCARGO_HOME=${shellQuote(cargoHome)} RUSTUP_HOME=${shellQuote(rustupHome)} ${shellQuote(path.join(cargoHome, 'bin', 'cargo'))} --version`;
  return {
    kind: 'rust', title: `Rust ${toolchain}`, script, env: {}, pathPrepend: [path.join(cargoHome, 'bin')],
    installedKey: `rust:${toolchain}`, installedValue: { kind: 'rust', version: toolchain, source: 'static.rust-lang.org/rustup' },
  };
}

function nodePlan(root, input) {
  const requested = safeVersion(input?.version, 'lts', 'Node.js', /^(?:lts|current|\d+\.\d+\.\d+)$/);
  const arch = linuxArch('node');
  const { downloads, toolchains } = commonDirs(root);
  const install = path.join(toolchains, 'node', slug(requested));
  const archive = path.join(downloads, `node-${slug(requested)}.tar.xz`);
  const picker = requested === 'lts'
    ? "print(next(x['version'][1:] for x in data if x.get('lts')))"
    : requested === 'current'
      ? "print(data[0]['version'][1:])"
      : `target=${JSON.stringify(requested)}\nassert any(x.get('version')=='v'+target for x in data), 'Node.js release not found: '+target\nprint(target)`;
  const script = `set -euo pipefail\nmkdir -p ${shellQuote(downloads)} ${shellQuote(path.dirname(install))}\nif [ ! -x ${shellQuote(path.join(install, 'bin', 'node'))} ]; then\n  INDEX="$(curl -fsSL https://nodejs.org/dist/index.json)"\n  VERSION="$(printf '%s' "$INDEX" | python3 -c ${shellQuote(`import json,sys\ndata=json.load(sys.stdin)\n${picker}`)})"\n  FILE="node-v$VERSION-linux-${arch}.tar.xz"\n  BASE="https://nodejs.org/dist/v$VERSION"\n  curl -fL --retry 3 --retry-delay 1 "$BASE/$FILE" -o ${shellQuote(archive)}\n  EXPECTED="$(curl -fsSL "$BASE/SHASUMS256.txt" | awk -v file="$FILE" '$2 == file {print $1; exit}')"\n  test -n "$EXPECTED"\n  printf '%s  %s\\n' "$EXPECTED" ${shellQuote(archive)} | sha256sum -c -\n  TMP=${shellQuote(`${install}.tmp`)}\n  rm -rf "$TMP" ${shellQuote(install)}\n  mkdir -p "$TMP"\n  tar -xJf ${shellQuote(archive)} -C "$TMP" --strip-components=1\n  test -x "$TMP/bin/node"\n  mv "$TMP" ${shellQuote(install)}\nfi\n${shellQuote(path.join(install, 'bin', 'node'))} --version\n${shellQuote(path.join(install, 'bin', 'npm'))} --version`;
  return {
    kind: 'node', title: `Node.js ${requested}`, script, env: {}, pathPrepend: [path.join(install, 'bin')],
    installedKey: `node:${requested}`, installedValue: { kind: 'node', version: requested, source: 'nodejs.org' },
  };
}

function mavenPlan(root, input) {
  const requested = safeVersion(input?.version, 'latest', 'Maven', /^(?:latest|\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/);
  const { downloads, toolchains } = commonDirs(root);
  const install = path.join(toolchains, 'maven', slug(requested));
  const archive = path.join(downloads, `maven-${slug(requested)}.tar.gz`);
  const resolveVersion = requested === 'latest'
    ? `META="$(curl -fsSL https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/maven-metadata.xml)"\n  VERSION="$(printf '%s' "$META" | python3 -c ${shellQuote("import re,sys,xml.etree.ElementTree as ET\nr=ET.fromstring(sys.stdin.read())\nvs=[x.text for x in r.findall('./versioning/versions/version') if x.text and re.fullmatch(r'3\\.\\d+\\.\\d+', x.text)]\nassert vs, 'Maven 3 release metadata missing'\nprint(vs[-1])")})"`
    : `VERSION=${shellQuote(requested)}`;
  const script = `set -euo pipefail\ncommand -v java >/dev/null 2>&1 || { echo 'Java is required; provision kind=java first' >&2; exit 42; }\nmkdir -p ${shellQuote(downloads)} ${shellQuote(path.dirname(install))}\nif [ ! -x ${shellQuote(path.join(install, 'bin', 'mvn'))} ]; then\n  ${resolveVersion}\n  FILE="apache-maven-$VERSION-bin.tar.gz"\n  PRIMARY="https://dlcdn.apache.org/maven/maven-3/$VERSION/binaries"\n  ARCHIVE="https://archive.apache.org/dist/maven/maven-3/$VERSION/binaries"\n  if ! curl -fL --retry 2 "$PRIMARY/$FILE" -o ${shellQuote(archive)}; then curl -fL --retry 2 "$ARCHIVE/$FILE" -o ${shellQuote(archive)}; PRIMARY="$ARCHIVE"; fi\n  EXPECTED="$(curl -fsSL "$PRIMARY/$FILE.sha512" | awk 'NR==1 {print $1}')"\n  test -n "$EXPECTED"\n  printf '%s  %s\\n' "$EXPECTED" ${shellQuote(archive)} | sha512sum -c -\n  TMP=${shellQuote(`${install}.tmp`)}\n  rm -rf "$TMP" ${shellQuote(install)}\n  mkdir -p "$TMP"\n  tar -xzf ${shellQuote(archive)} -C "$TMP" --strip-components=1\n  test -x "$TMP/bin/mvn"\n  mv "$TMP" ${shellQuote(install)}\nfi\n${shellQuote(path.join(install, 'bin', 'mvn'))} --version`;
  return {
    kind: 'maven', title: `Maven ${requested}`, script, env: {}, pathPrepend: [path.join(install, 'bin')],
    installedKey: `maven:${requested}`, installedValue: { kind: 'maven', version: requested, source: 'Apache Maven' },
  };
}

function flutterPlan(root, input) {
  if (process.arch !== 'x64') throw new Error('Flutter managed provisioning currently supports Linux x64 only; use portable with an official checksum for another architecture.');
  const requested = safeVersion(input?.version, 'stable', 'Flutter', /^(?:stable|beta|\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/);
  const { downloads, toolchains } = commonDirs(root);
  const install = path.join(toolchains, 'flutter', slug(requested));
  const archive = path.join(downloads, `flutter-${slug(requested)}.tar.xz`);
  const selector = requested === 'stable' || requested === 'beta'
    ? `channel=${JSON.stringify(requested)}\nhash_=data['current_release'][channel]\nr=next(x for x in data['releases'] if x.get('hash')==hash_)`
    : `version=${JSON.stringify(requested)}\nr=next((x for x in data['releases'] if x.get('version')==version), None)\nassert r, 'Flutter release not found: '+version`;
  const script = `set -euo pipefail\nmkdir -p ${shellQuote(downloads)} ${shellQuote(path.dirname(install))}\nif [ ! -x ${shellQuote(path.join(install, 'bin', 'flutter'))} ]; then\n  META="$(curl -fsSL https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json)"\n  ROW="$(printf '%s' "$META" | python3 -c ${shellQuote(`import json,sys\ndata=json.load(sys.stdin)\n${selector}\nprint(r['archive'])\nprint(r['sha256'])`)})"\n  ARCHIVE_PATH="$(printf '%s\\n' "$ROW" | sed -n '1p')"\n  SHA="$(printf '%s\\n' "$ROW" | sed -n '2p')"\n  test -n "$ARCHIVE_PATH"\n  test -n "$SHA"\n  URL="https://storage.googleapis.com/flutter_infra_release/releases/$ARCHIVE_PATH"\n  curl -fL --retry 3 --retry-delay 1 "$URL" -o ${shellQuote(archive)}\n  printf '%s  %s\\n' "$SHA" ${shellQuote(archive)} | sha256sum -c -\n  TMP=${shellQuote(`${install}.tmp`)}\n  rm -rf "$TMP" ${shellQuote(install)}\n  mkdir -p "$TMP"\n  tar -xf ${shellQuote(archive)} -C "$TMP"\n  test -x "$TMP/flutter/bin/flutter"\n  mv "$TMP/flutter" ${shellQuote(install)}\n  rm -rf "$TMP"\nfi\nCI=true FLUTTER_SUPPRESS_ANALYTICS=true ${shellQuote(path.join(install, 'bin', 'flutter'))} --version`;
  return {
    kind: 'flutter', title: `Flutter ${requested}`, script, env: {}, pathPrepend: [path.join(install, 'bin')],
    installedKey: `flutter:${requested}`, installedValue: { kind: 'flutter', version: requested, source: 'Flutter SDK archive' },
  };
}

function kubectlPlan(root, input) {
  const requested = safeVersion(input?.version, 'stable', 'kubectl', /^(?:stable|v?\d+\.\d+\.\d+)$/);
  const arch = linuxArch('kubectl');
  const { downloads, toolchains } = commonDirs(root);
  const install = path.join(toolchains, 'kubectl', slug(requested));
  const binary = path.join(install, 'bin', 'kubectl');
  const downloaded = path.join(downloads, `kubectl-${slug(requested)}`);
  const resolveVersion = requested === 'stable'
    ? 'VERSION="$(curl -fsSL https://dl.k8s.io/release/stable.txt)"'
    : `VERSION=${shellQuote(requested.startsWith('v') ? requested : `v${requested}`)}`;
  const script = `set -euo pipefail\nmkdir -p ${shellQuote(downloads)} ${shellQuote(path.dirname(binary))}\nif [ ! -x ${shellQuote(binary)} ]; then\n  ${resolveVersion}\n  URL="https://dl.k8s.io/release/$VERSION/bin/linux/${arch}/kubectl"\n  curl -fL --retry 3 --retry-delay 1 "$URL" -o ${shellQuote(downloaded)}\n  EXPECTED="$(curl -fsSL "$URL.sha256" | tr -d '[:space:]')"\n  test -n "$EXPECTED"\n  printf '%s  %s\\n' "$EXPECTED" ${shellQuote(downloaded)} | sha256sum -c -\n  install -m 0755 ${shellQuote(downloaded)} ${shellQuote(binary)}\nfi\n${shellQuote(binary)} version --client --output=yaml`;
  return {
    kind: 'kubectl', title: `kubectl ${requested}`, script, env: {}, pathPrepend: [path.dirname(binary)],
    installedKey: `kubectl:${requested}`, installedValue: { kind: 'kubectl', version: requested, source: 'dl.k8s.io' },
  };
}

function terraformPlan(root, input) {
  const requested = safeVersion(input?.version, 'latest', 'Terraform', /^(?:latest|\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)$/);
  const arch = linuxArch('terraform');
  const { downloads, toolchains } = commonDirs(root);
  const install = path.join(toolchains, 'terraform', slug(requested));
  const archive = path.join(downloads, `terraform-${slug(requested)}.zip`);
  const resolveVersion = requested === 'latest'
    ? `VERSION="$(curl -fsSL 'https://checkpoint-api.hashicorp.com/v1/check/terraform' | python3 -c ${shellQuote("import json,sys\nprint(json.load(sys.stdin)['current_version'])")})"`
    : `VERSION=${shellQuote(requested)}`;
  const script = `set -euo pipefail\nmkdir -p ${shellQuote(downloads)} ${shellQuote(path.join(install, 'bin'))}\nif [ ! -x ${shellQuote(path.join(install, 'bin', 'terraform'))} ]; then\n  ${resolveVersion}\n  FILE="terraform_${'${VERSION}'}_linux_${arch}.zip"\n  BASE="https://releases.hashicorp.com/terraform/$VERSION"\n  curl -fL --retry 3 --retry-delay 1 "$BASE/$FILE" -o ${shellQuote(archive)}\n  EXPECTED="$(curl -fsSL "$BASE/terraform_${'${VERSION}'}_SHA256SUMS" | awk -v file="$FILE" '$2 == file {print $1; exit}')"\n  test -n "$EXPECTED"\n  printf '%s  %s\\n' "$EXPECTED" ${shellQuote(archive)} | sha256sum -c -\n  TMP=${shellQuote(`${install}.tmp`)}\n  rm -rf "$TMP"\n  mkdir -p "$TMP"\n  unzip -q ${shellQuote(archive)} -d "$TMP"\n  test -x "$TMP/terraform"\n  install -m 0755 "$TMP/terraform" ${shellQuote(path.join(install, 'bin', 'terraform'))}\n  rm -rf "$TMP"\nfi\n${shellQuote(path.join(install, 'bin', 'terraform'))} version`;
  return {
    kind: 'terraform', title: `Terraform ${requested}`, script, env: {}, pathPrepend: [path.join(install, 'bin')],
    installedKey: `terraform:${requested}`, installedValue: { kind: 'terraform', version: requested, source: 'releases.hashicorp.com' },
  };
}

function safePortableRelative(value, label) {
  const text = String(value || '').trim().replace(/\\/g, '/');
  if (!text || text.length > 240 || text.startsWith('/') || text.split('/').includes('..') || !/^[A-Za-z0-9._/+:-]+$/.test(text)) {
    throw new Error(`Unsafe portable ${label}: ${JSON.stringify(text)}`);
  }
  return text;
}

function portablePlan(root, input) {
  const name = safePortableRelative(input?.name, 'name');
  if (name.includes('/')) throw new Error('Portable name must be a single command name');
  const url = String(input?.url || '').trim();
  if (!/^https:\/\/[^\s]+$/i.test(url) || url.length > 2000) throw new Error('Portable URL must be an HTTPS URL');
  const sha256 = String(input?.sha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Portable sha256 must be exactly 64 hexadecimal characters');
  const archiveType = String(input?.archiveType || 'raw').trim().toLowerCase();
  if (!['raw', 'zip', 'tar.gz', 'tar.xz'].includes(archiveType)) throw new Error('Portable archiveType must be raw, zip, tar.gz, or tar.xz');
  const binaryPath = archiveType === 'raw' ? name : safePortableRelative(input?.binaryPath, 'binaryPath');
  const version = safeVersion(input?.version, 'custom', 'portable', /^[A-Za-z0-9._+-]+$/);
  const { downloads, toolchains } = commonDirs(root);
  const install = path.join(toolchains, 'portable', name, slug(version));
  const download = path.join(downloads, `portable-${name}-${slug(version)}`);
  const output = path.join(install, 'bin', name);
  let extract;
  if (archiveType === 'raw') {
    extract = `install -m 0755 ${shellQuote(download)} ${shellQuote(output)}`;
  } else if (archiveType === 'zip') {
    extract = `python3 - ${shellQuote(download)} ${shellQuote(binaryPath)} ${shellQuote(output)} <<'PY'\nimport os, stat, sys, zipfile\narchive, member_name, output = sys.argv[1:]\nwith zipfile.ZipFile(archive) as zf:\n    info = zf.getinfo(member_name)\n    mode = (info.external_attr >> 16) & 0xffff\n    if info.is_dir() or stat.S_ISLNK(mode):\n        raise SystemExit('portable binaryPath is not a regular file')\n    data = zf.read(info)\nos.makedirs(os.path.dirname(output), exist_ok=True)\nwith open(output, 'wb') as fh: fh.write(data)\nos.chmod(output, 0o755)\nPY`;
  } else {
    extract = `python3 - ${shellQuote(download)} ${shellQuote(binaryPath)} ${shellQuote(output)} <<'PY'\nimport os, sys, tarfile\narchive, member_name, output = sys.argv[1:]\nwith tarfile.open(archive, 'r:*') as tf:\n    member = tf.getmember(member_name)\n    if not member.isfile():\n        raise SystemExit('portable binaryPath is not a regular file')\n    src = tf.extractfile(member)\n    if src is None: raise SystemExit('portable binaryPath cannot be read')\n    data = src.read()\nos.makedirs(os.path.dirname(output), exist_ok=True)\nwith open(output, 'wb') as fh: fh.write(data)\nos.chmod(output, 0o755)\nPY`;
  }
  const script = `set -euo pipefail\nmkdir -p ${shellQuote(downloads)} ${shellQuote(path.dirname(output))}\nif [ ! -x ${shellQuote(output)} ]; then\n  curl -fL --retry 3 --retry-delay 1 ${shellQuote(url)} -o ${shellQuote(download)}\n  printf '%s  %s\\n' ${shellQuote(sha256)} ${shellQuote(download)} | sha256sum -c -\n  ${extract}\nfi\n# `|| true` below swallows every failure mode of the probe, so verify the\n# artefact separately: a truncated or wrong-arch download used to be reported\n# as a successful install.\ntest -x ${shellQuote(output)}\n${shellQuote(output)} --version || ${shellQuote(output)} version || true`;
  return {
    kind: 'portable', title: `${name} ${version}`, script, env: {}, pathPrepend: [path.dirname(output)],
    installedKey: `portable:${name}:${version}`, installedValue: { kind: 'portable', name, version, source: url, sha256 },
  };
}

export function prepareToolchainRequirement(root, input = {}) {
  const kind = String(input?.kind || '').trim().toLowerCase();
  if (kind === 'go') return goPlan(root, input);
  if (kind === 'rust') return rustPlan(root, input);
  if (kind === 'node') return nodePlan(root, input);
  if (kind === 'maven') return mavenPlan(root, input);
  if (kind === 'flutter') return flutterPlan(root, input);
  if (kind === 'kubectl') return kubectlPlan(root, input);
  if (kind === 'terraform') return terraformPlan(root, input);
  if (CLOUD_TOOLCHAIN_KINDS.includes(kind)) return prepareCloudToolchainRequirement(root, input);
  if (kind === 'portable') return portablePlan(root, input);
  throw new Error(`Unsupported extended toolchain kind: ${kind || '(empty)'}`);
}

const COMMAND_HINTS = new Map([
  ['java', 'java'], ['javac', 'java'],
  ['gradle', 'gradle'],
  ['python', 'python'], ['python3', 'python'], ['pip', 'python'], ['pip3', 'python'],
  ['sdkmanager', 'android'], ['adb', 'android'],
  ['go', 'go'], ['gofmt', 'go'],
  ['rustc', 'rust'], ['cargo', 'rust'], ['rustup', 'rust'],
  ['node', 'node'], ['npm', 'node'], ['npx', 'node'], ['corepack', 'node'],
  ['mvn', 'maven'],
  ['flutter', 'flutter'], ['dart', 'flutter'],
  ['kubectl', 'kubectl'],
  ['terraform', 'terraform'],
  ['aws', 'aws'],
  ['gcloud', 'gcloud'], ['gsutil', 'gcloud'], ['bq', 'gcloud'],
]);

export function suggestToolchainForCommand(command) {
  const name = String(command || '').trim().toLowerCase();
  const kind = COMMAND_HINTS.get(name);
  return kind ? { command: name, kind } : null;
}
