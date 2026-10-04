# Installable Agent Skills

ZetaAgent supports the open [Agent Skills](https://agentskills.io/specification) format: a `SKILL.md` with YAML `name`/`description`, plus optional scripts, references and assets. The system uses progressive disclosure: an index of names/descriptions is supplied first, full instructions and files are loaded only when a skill is selected.

## User interface

Open **Settings → Память и навыки → Скиллы**. You can:

- Inspect a public GitHub repository/subdirectory, an HTTPS `SKILL.md`, ZIP URL, or an article with source links.
- Upload `SKILL.md` or a ZIP (up to 16 MB through the UI).
- Choose individual skills rather than installing an entire repository implicitly.
- Enable/disable a skill globally and allow/disable implicit selection.
- Inspect source, immutable GitHub revision, compatibility notes and file count.
- Check a source again and explicitly replace an installed skill. Conflicting names are never silently overwritten by installation.

Above the message composer, **Скиллы** controls the current chat:

- **Auto:** the agent sees enabled, implicitly invocable skills, plus explicitly pinned skills.
- **Manual:** only the selected skills are available.
- **Off:** skill reading/discovery/installation is disabled through the agent tool.
- Pin up to eight skills; exclude particular skills from auto mode.
- Allow or prohibit the agent from installing skills in this chat. The agent is instructed to install only when the user requests installation/study/selection of skills for a task.

Explicit `$skill-name` or `/skill-name` mentions pin an installed, globally enabled skill for the chat. They do not override Off mode. Selected instructions are reattached on each turn with a 48,000-character combined budget; oversized selections remain available through `skill read`. The initial automatic index has an 8,000-character budget; `skill list` with `query` searches the complete available index.

## Agent workflow

Example user request: “Study this article. We will design a dashboard. Install the skills you need.”

1. `skill {action: "discover", source: articleURL}` returns source links.
2. Discover a relevant repository; inspect the skill descriptions, paths and warnings.
3. `skill {action: "install", source: preview.source, path: candidate.path}` installs ONE package into the owner's persistent library.
4. `skill {action: "read", name: skillName}` loads instructions and copies the package to a versioned `.agent-skills/` directory inside this chat's workspace.
5. Resolve references from that directory. Inspect scripts, then use the existing sandboxed tools when execution is appropriate.

The library is owner-scoped, not shared between unrelated users. Installations survive new chats and server restarts. Package contents are stored in SQLite and included in existing database backups. Materialized files are workspace copies: editing them cannot alter the library. A content-verified copy is reused across turns.

GitHub discovery uses a pinned commit and selective raw-file downloads, so large repositories are not downloaded in full. The generic ZIP loader validates the central directory and enforces path, file-count, special-file and decompressed-size limits. Upload/preview IDs are owner-scoped, bounded in memory, and expire after ten minutes; rediscover expired sources.

## Compatibility and safety

Supported: portable Markdown instructions, YAML folded/block descriptions, scripts/resources/assets; Claude `disable-model-invocation` and Codex `agents/openai.yaml` `policy.allow_implicit_invocation` are respected when installing.

Not automatically implemented: plugin marketplaces, MCP connections, hooks, `context: fork`, agent definitions, dynamic `!\`shell\`` interpolation, `allowed-tools` permission grants, or proprietary platform APIs. They are retained/documented as compatibility notes. A skill requiring unavailable dependencies may need adaptation. An install does not execute code or grant sudo, filesystem or network access.

External content is untrusted guidance. Existing tools and deployment isolation remain the security boundary; users of the deliberately unrestricted single-user profile should not execute unfamiliar scripts without review.

Public HTTPS sources only in this release. Private GitHub authentication and full marketplace/plugin installations are not supported. GitHub API rate limits are reported rather than bypassed.

Limits: 500 installed skills per owner; 1,500 files and 16 MB per package; 4 MB per resource; 96 KB per `SKILL.md`; generic source downloads 64 MB. A source exceeding these limits requires a narrower package. No secrets/credential files or symlinks are imported. Updates require explicit replacement; they are not scheduled automatically.

## API

Authenticated routes use existing cookie auth/CSRF and owner checks:

- `GET /api/user/skills?metadata=1` — lightweight library index.
- `POST /api/user/skills/discover` — `{source, ref?}` or `{filename, contentBase64}`.
- `POST /api/user/skills/install` — `{source, path?, name?, replace?}`.
- `PATCH /api/user/skills/:id` — `{enabled?, autoUse?}`.
- `GET|PUT /api/session/:id/skills` — `{mode, selected, excluded, allowInstall}`.

Existing recipe save/delete routes and tools remain compatible. Agent `skill` actions now include `discover`, `install`, `enable`, `disable`, alongside `list`, `read`, `save`, `delete`.
