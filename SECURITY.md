# Security model

Z Agent Native is an autonomous agent execution environment. Tool calls are approved automatically by the runtime, so a model-selected shell command can run arbitrary programs and can reach hosts that are reachable from the runtime container. The security boundary therefore has to exist below the model, not in a browser confirmation dialog.

## Runtime secrets

- Provider keys are encrypted with AES-256-GCM before SQLite persistence.
- The encryption key comes from `Z_AGENT_SECRET_KEY` or a runtime-generated `data/master.key` with mode 0600.
- Provider keys and runtime secrets are never injected into tool/terminal environments.
- HTTP 5xx responses return a request ID instead of internal exception details.

## Authentication

- Passwords use scrypt with per-user random salt.
- Login sessions use random HttpOnly cookies.
- Unsafe HTTP methods require a matching double-submit CSRF token.
- Cookies are SameSite=Lax; production HTTPS should enable `Z_AGENT_SECURE_COOKIES=1`.
- Login/register attempts are rate-limited per remote address.
- Password changes revoke other login sessions.

## Filesystem boundary

- Every chat has one workspace root.
- Path traversal and symlink escape are rejected before file operations.
- Uploads, downloads, previews and agent file tools all resolve inside that root.
- Runtime data (`/data` in Docker) is separate from agent workspaces.

## External process boundary

The supplied Docker deployment runs the trusted runtime as container root only so it can drop privileges for agent processes. Each chat gets a unique Unix UID; UIDs are never reused after chat deletion.

The following run as the chat UID with a minimal environment:

- `bash`
- `git apply` used by `apply_patch`
- interactive terminal
- Workspace Git status

The chat workspace is mode 0700. `/workspaces` is traversable but not listable; sibling session roots remain inaccessible. `/data` is mode 0700 and cannot be traversed by agent UIDs.

On non-root bare metal, shell/terminal are disabled by default. `Z_AGENT_ALLOW_UNISOLATED_SHELL=1` is an explicit unsafe single-user development fallback, not a production mode.

## Network boundary

User-supplied custom model endpoints and `webfetch` are SSRF-filtered. Loopback, private, link-local, reserved, metadata-like and unsafe DNS results are rejected. Administrator-configured provider base URLs are intentionally trusted so a deployment can use a local/VPC LLM gateway.

## Automatic tool approval

Write/edit/patch/bash/webfetch/websearch/environment tool calls do not stop for interactive permission confirmation. The native runtime approves those permission gates immediately so an agent turn can continue without depending on a browser tab or network round-trip.

This does **not** bypass the lower-level security controls: workspace path validation, per-session Unix identities, shell sandbox availability checks, SSRF filtering, provider-secret isolation and other tool-specific validation still apply. User questions are separate from permissions and may still pause a turn when the model genuinely needs information from the user.

## Deployment rules

For production:

1. Use the supplied Docker image.
2. Mount only the dedicated `/data` and `/workspaces` volumes.
3. Never mount the Docker socket or arbitrary host roots into the runtime.
4. Serve through HTTPS and enable secure cookies.
5. Configure an invite code or an external access layer before public exposure.
6. Store `Z_AGENT_SECRET_KEY` and optional search credentials in a secrets manager.
7. Treat every enabled tool as autonomously executable by the model; expose only networks, credentials and mounts that the agent is allowed to reach.
8. Back up both runtime data and workspaces; retain the encryption key needed to decrypt provider credentials.
