import path from 'node:path';

export const CLOUD_TOOLCHAIN_KINDS = ['aws', 'gcloud'];

const AWS_KEY_FINGERPRINT = 'FB5DB77FD5C118B80511ADA8A6310ACC4672475C';
const AWS_CLI_PUBLIC_KEY = `-----BEGIN PGP PUBLIC KEY BLOCK-----
mQINBF2Cr7UBEADJZHcgusOJl7ENSyumXh85z0TRV0xJorM2B/JL0kHOyigQluUG
ZMLhENaG0bYatdrKP+3H91lvK050pXwnO/R7fB/FSTouki4ciIx5OuLlnJZIxSzx
PqGl0mkxImLNbGWoi6Lto0LYxqHN2iQtzlwTVmq9733zd3XfcXrZ3+LblHAgEt5G
TfNxEKJ8soPLyWmwDH6HWCnjZ/aIQRBTIQ05uVeEoYxSh6wOai7ss/KveoSNBbYz
gbdzoqI2Y8cgH2nbfgp3DSasaLZEdCSsIsK1u05CinE7k2qZ7KgKAUIcT/cR/grk
C6VwsnDU0OUCideXcQ8WeHutqvgZH1JgKDbznoIzeQHJD238GEu+eKhRHcz8/jeG
94zkcgJOz3KbZGYMiTh277Fvj9zzvZsbMBCedV1BTg3TqgvdX4bdkhf5cH+7NtWO
lrFj6UwAsGukBTAOxC0l/dnSmZhJ7Z1KmEWilro/gOrjtOxqRQutlIqG22TaqoPG
fYVN+en3Zwbt97kcgZDwqbuykNt64oZWc4XKCa3mprEGC3IbJTBFqglXmZ7l9ywG
EEUJYOlb2XrSuPWml39beWdKM8kzr1OjnlOm6+lpTRCBfo0wa9F8YZRhHPAkwKkX
XDeOGpWRj4ohOx0d2GWkyV5xyN14p2tQOCdOODmz80yUTgRpPVQUtOEhXQARAQAB
tCFBV1MgQ0xJIFRlYW0gPGF3cy1jbGlAYW1hem9uLmNvbT6JAlQEEwEIAD4CGwMF
CwkIBwIGFQoJCAsCBBYCAwECHgECF4AWIQT7Xbd/1cEYuAURraimMQrMRnJHXAUC
akV0ygUJDqP4lQAKCRCmMQrMRnJHXFHjD/9eyZLYcKuQOlLvtqSDtUBiEZf6ZZjM
i3ygYH8rJNtuToUH+HvSpe819urJCquXhDrlK6N+aqW0hCLtNABJG/vsafIgvIYJ
hSGgpgtNnQyMV1jViRWqPjbouw8OkYKBThUfT1i2Y+wn58ifs6ODBCmTexWtXspA
Si+Gt49xDOW0APmbOPnI+a4HJW6tVEo6MWS0WjzpiBayR3d1A4pt4YrPfSdDgpLo
h2SLQqlRqvvVZJaWBjhkErNFpfsBA06sDcPEOb0G8LBUbR4WOcdvhe5LubJbZuxC
AG9kNPCVeQP1ixwjgjXKysaxeQ6rv0VzIQgRp6tLVLWhy6AKDNvLjFSsmXZ1Wl08
Y/RlOHXlzLuQMRE6sR1wOdRxc9TsrNWTGiBK65cvSWOy03JeBkQQ8pesqltiyxI9
U21kkgiXtTSKNGfKK8pO27D81YANhRqPK7iTp6kuFiY2WtOg90KTMNlIT+Ff85Y2
b1rHj6Z0SrCkJujhWk3IBPic/wJgz01LEc/OAdUPlby90RJZcIBhSlWhT7mXnXIO
c0HWlNQrns2s3CTyYwZSiSlYe9ApeLwhjDo8NhbFuCAy61l6O5UsR4AfZxx/rGKv
2wFb1/RN/P4gNe6vmxZAPjR0AQcwD3tc2McimOLr/22kmPz8IH3I0X7WoSFr0Biz
E91G7bb0hOb/cA==
=knv7
-----END PGP PUBLIC KEY BLOCK-----`;

function agentHome(root) { return path.join(root, '.agent-home'); }
function shellQuote(value) { return `'${String(value).replace(/'/g, `'"'"'`)}'`; }

function awsArch() {
  if (process.arch === 'x64') return 'x86_64';
  if (process.arch === 'arm64') return 'aarch64';
  throw new Error(`AWS CLI provisioning is not supported on ${process.arch}`);
}

function gcloudArch() {
  if (process.arch === 'x64') return 'x86_64';
  if (process.arch === 'arm64') return 'arm';
  throw new Error(`Google Cloud CLI provisioning is not supported on ${process.arch}`);
}

function requireSha256(input, label) {
  const sha = String(input?.sha256 || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) {
    throw new Error(`${label} requires sha256 from the official release/download page (64 hexadecimal characters)`);
  }
  return sha;
}

function awsPlan(root, input) {
  const version = String(input?.version || 'latest').trim().toLowerCase();
  if (version !== 'latest') throw new Error('AWS CLI managed provisioning currently supports version=latest only');
  const arch = awsArch();
  const home = agentHome(root);
  const downloads = path.join(home, 'downloads');
  const toolRoot = path.join(home, 'toolchains', 'aws', 'latest');
  const installDir = path.join(toolRoot, 'aws-cli');
  const binDir = path.join(toolRoot, 'bin');
  const archive = path.join(downloads, `awscliv2-${arch}.zip`);
  const signature = `${archive}.sig`;
  const keyFile = path.join(downloads, 'aws-cli-team.asc');
  const gnupgHome = path.join(home, 'cache', 'aws-gnupg');
  const extractDir = path.join(home, 'toolchains', 'aws', 'installer.tmp');
  const url = `https://awscli.amazonaws.com/awscli-exe-linux-${arch}.zip`;
  const script = `set -euo pipefail\ncommand -v gpg >/dev/null 2>&1 || { echo 'gpg is unavailable in the runtime image' >&2; exit 42; }\nmkdir -p ${shellQuote(downloads)} ${shellQuote(binDir)} ${shellQuote(gnupgHome)}\nchmod 0700 ${shellQuote(gnupgHome)}\nif [ ! -x ${shellQuote(path.join(binDir, 'aws'))} ]; then\n  curl -fL --retry 3 --retry-delay 1 ${shellQuote(url)} -o ${shellQuote(archive)}\n  curl -fL --retry 3 --retry-delay 1 ${shellQuote(`${url}.sig`)} -o ${shellQuote(signature)}\n  cat > ${shellQuote(keyFile)} <<'AWSCLIKEY'\n${AWS_CLI_PUBLIC_KEY}\nAWSCLIKEY\n  GNUPGHOME=${shellQuote(gnupgHome)} gpg --batch --import ${shellQuote(keyFile)} >/dev/null 2>&1\n  FINGERPRINT="$(GNUPGHOME=${shellQuote(gnupgHome)} gpg --batch --with-colons --fingerprint A6310ACC4672475C | awk -F: '$1 == "fpr" {print $10; exit}')"\n  test "$FINGERPRINT" = ${shellQuote(AWS_KEY_FINGERPRINT)}\n  GNUPGHOME=${shellQuote(gnupgHome)} gpg --batch --verify ${shellQuote(signature)} ${shellQuote(archive)}\n  rm -rf ${shellQuote(extractDir)}\n  mkdir -p ${shellQuote(extractDir)}\n  unzip -q ${shellQuote(archive)} -d ${shellQuote(extractDir)}\n  test -x ${shellQuote(path.join(extractDir, 'aws', 'install'))}\n  ${shellQuote(path.join(extractDir, 'aws', 'install'))} --install-dir ${shellQuote(installDir)} --bin-dir ${shellQuote(binDir)} --update\n  rm -rf ${shellQuote(extractDir)}\nfi\n${shellQuote(path.join(binDir, 'aws'))} --version`;
  return {
    kind: 'aws', title: 'AWS CLI v2 latest', script, env: {}, pathPrepend: [binDir],
    installedKey: 'aws:latest', installedValue: { kind: 'aws', version: 'latest', source: 'awscli.amazonaws.com', verification: 'PGP', fingerprint: AWS_KEY_FINGERPRINT },
  };
}

function gcloudPlan(root, input) {
  const sha256 = requireSha256(input, 'Google Cloud CLI provisioning');
  const version = String(input?.version || 'latest').trim().toLowerCase();
  if (version !== 'latest') throw new Error('Google Cloud CLI managed provisioning currently supports version=latest only; use portable for a pinned versioned archive');
  const arch = gcloudArch();
  const home = agentHome(root);
  const downloads = path.join(home, 'downloads');
  const install = path.join(home, 'toolchains', 'gcloud', 'latest');
  const archive = path.join(downloads, `google-cloud-cli-${arch}-latest.tar.gz`);
  const filename = `google-cloud-cli-linux-${arch}.tar.gz`;
  const url = `https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/${filename}`;
  const script = `set -euo pipefail\nmkdir -p ${shellQuote(downloads)} ${shellQuote(path.dirname(install))}\nif [ ! -x ${shellQuote(path.join(install, 'google-cloud-sdk', 'bin', 'gcloud'))} ]; then\n  curl -fL --retry 3 --retry-delay 1 ${shellQuote(url)} -o ${shellQuote(archive)}\n  printf '%s  %s\\n' ${shellQuote(sha256)} ${shellQuote(archive)} | sha256sum -c -\n  TMP=${shellQuote(`${install}.tmp`)}\n  rm -rf "$TMP" ${shellQuote(install)}\n  mkdir -p "$TMP"\n  tar -xzf ${shellQuote(archive)} -C "$TMP"\n  test -x "$TMP/google-cloud-sdk/bin/gcloud"\n  mv "$TMP" ${shellQuote(install)}\n  ${shellQuote(path.join(install, 'google-cloud-sdk', 'install.sh'))} --quiet --path-update=false --command-completion=false --usage-reporting=false >/dev/null\nfi\n${shellQuote(path.join(install, 'google-cloud-sdk', 'bin', 'gcloud'))} --version`;
  return {
    kind: 'gcloud', title: 'Google Cloud CLI latest', script, env: {}, pathPrepend: [path.join(install, 'google-cloud-sdk', 'bin')],
    installedKey: 'gcloud:latest', installedValue: { kind: 'gcloud', version: 'latest', source: 'dl.google.com', sha256 },
  };
}

export function prepareCloudToolchainRequirement(root, input = {}) {
  const kind = String(input?.kind || '').trim().toLowerCase();
  if (kind === 'aws') return awsPlan(root, input);
  if (kind === 'gcloud') return gcloudPlan(root, input);
  throw new Error(`Unsupported cloud toolchain kind: ${kind || '(empty)'}`);
}
