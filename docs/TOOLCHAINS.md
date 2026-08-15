# Z Agent toolchain manager

`ensure_environment` gives an agent a self-service development environment without granting `sudo`, host root, a Docker socket, or access to another chat workspace.

Managed installations live below the chat workspace's hidden `.agent-home/`. Their PATH entries are persisted in the existing environment manifest and are automatically inherited by later `bash` calls and by the interactive terminal.

## Built-in provisioners

| kind | Purpose | Integrity model |
| --- | --- | --- |
| `python` | Session virtualenv and pip packages | pip/TLS in an isolated venv |
| `java` | Eclipse Temurin JDK major versions | release SHA-256 |
| `gradle` | Gradle binary distributions | distribution SHA-256 |
| `android` | Android command-line tools and SDK packages | pinned command-line-tools SHA-256; explicit license acceptance |
| `go` | Go toolchain, latest or explicit release | checksum from the official Go release JSON |
| `rust` | rustup + stable/beta/nightly/explicit toolchain | official rustup-init SHA-256 |
| `node` | Node.js LTS/current/explicit release | official `SHASUMS256.txt` |
| `maven` | Latest Maven 3 or explicit release | Apache `.sha512` sidecar |
| `flutter` | Stable/beta/explicit Flutter SDK on Linux x64 | checksum from the official Flutter release manifest |
| `kubectl` | Stable or explicit Kubernetes client | official `.sha256` sidecar |
| `terraform` | Latest or explicit Terraform CLI | HashiCorp `SHA256SUMS` |
| `aws` | Latest AWS CLI v2 | official AWS CLI Team PGP signature + pinned signer fingerprint |
| `gcloud` | Latest Google Cloud CLI | SHA-256 resolved from the official Google Cloud download page, or explicitly supplied |
| `portable` | A CLI outside the catalog | trusted HTTPS URL + exact SHA-256 supplied to the permission-gated tool |

The `portable` mode is intentionally not an arbitrary installer script. It can expose one executable from a raw file, ZIP, `tar.gz`, or `tar.xz` archive only after the supplied SHA-256 matches. For archives it reads only the requested regular-file member rather than extracting the archive tree, so traversal paths and symlink members cannot become installed commands.

## Agent flow

A strong default flow is:

1. Inspect the repository and determine the actual tool/runtime requirement.
2. Use `environment_status` if command availability is unclear.
3. Call `ensure_environment` for the smallest missing requirement.
4. The existing permission gate shows the provisioning request to the user.
5. Verify the installed command with `bash`.
6. Continue the original task instead of ending with a generic "no root" response.
7. Build/test locally and verify requested artifacts before reporting them.

`bash` also detects common `command not found` failures with exit code 127. For known commands such as `cargo`, `mvn`, `terraform`, `flutter`, `kubectl`, `aws`, `gcloud`, `go`, `java`, `gradle`, `adb`, or `node`, the tool result includes an `environmentHint` mapping the missing command to the corresponding provisioner.

## Android example

A model can inspect an Android project, provision the required JDK and Android packages, and then build locally:

```text
ensure_environment(kind="java", version="21")
ensure_environment(
  kind="android",
  packages=["platform-tools", "platforms;android-36", "build-tools;36.0.0"],
  acceptLicenses=true
)
./gradlew assembleDebug
```

The resulting APK remains in the workspace and can be downloaded through the workspace download endpoint.

## Remote-service example

SSH itself is part of the base runtime. If a task specifically needs a Python API client, the agent can provision it without system-wide pip or root:

```text
ensure_environment(kind="python", packages=["paramiko"])
python -c "import paramiko; print(paramiko.__version__)"
```

Tool installation and service credentials remain separate capabilities. Provisioning a CLI/library does not expose credentials, provider secrets, or privileged host resources.

## Cloud CLI examples

AWS CLI v2 uses the official signed Linux bundle and a session-local install directory:

```text
ensure_environment(kind="aws")
aws --version
```

The runtime verifies the installer signature with the embedded AWS CLI Team public key and checks the expected signer fingerprint before installation. AWS credentials are not provisioned by this action.

For Google Cloud CLI, the runtime can resolve the current checksum itself from the official Google Cloud installation page before downloading the moving rapid-channel archive:

```text
ensure_environment(kind="gcloud")
gcloud --version
```

An explicit current official checksum may be supplied with `sha256` when desired. If the download page and rapid archive change between checksum resolution and download, verification fails safely instead of silently trusting the new archive. A pinned older gcloud archive can be installed through `portable` when an official versioned archive URL and checksum are available.

## Base image

The runtime image intentionally carries a bounded substrate useful across many tasks: Node.js, Python/venv/pip, OpenJDK 17, build-essential, CMake, Ninja, SSH/rsync/curl, PostgreSQL and SQLite clients, DNS/network diagnostics, `jq`, `ffmpeg`, `procps`, `lsof`, GnuPG, `groff`, and `less`.

System packages that genuinely require host/container administration are still not available to model shell commands. If a task depends on a kernel feature, privileged device, system daemon, unsupported architecture, or unavailable secret, the agent must report that concrete limitation rather than asking for unrestricted root.
