# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`1.0.0` predates this file and is the baseline; entries below describe changes
made on top of it.

## [Unreleased]

A stability pass. No capability was added to or removed from the product
surface; every change below either fixes a defect, removes unreachable code, or
makes an existing guarantee enforceable.

### Fixed

- **The hardened executor could be silently un-hardened by a file Docker loads
  on its own.** `docker-compose.override.yml` is applied automatically by every
  bare `docker compose up`, and it re-enabled the host terminal, networked
  installers, a permissive SSH policy, and bridge networking for the executor.
  Operators who followed the documented commands got the trusted profile without
  asking for it, and `npm run quality` failed on the test that asserts this
  cannot happen. The override is now limited to the local port mapping and the
  Caddy service; the trusted profile stays opt-in through the explicit
  `-f docker-compose.trusted.yml` flag that the README and OPERATIONS already
  document.
- **The `question` tool was implemented end to end but never offered to the
  model.** The dispatcher, the interruption lifecycle, the persistence layer,
  and the `QuestionCard` UI all handled it, yet it was missing from
  `TOOL_DEFINITIONS`, so no model could ever call it and the entire
  ask-the-user path was dead in practice. It is now advertised with the schema
  the runtime and the UI already consume, and it remains outside the permission
  and workspace-mutation sets, and outside every subagent profile.
- **Streamed assistant text was written to SQLite once per delta.** Persisting
  the growing part on every token meant a few thousand row rewrites for a single
  medium-sized answer, with the write amplification growing quadratically in the
  length of the reply. The part is now persisted once per update.
- **Three long-lived SQLite connections pointed at the same database file.**
  `provider-configs.mjs` and `cluster.mjs` each opened their own `DatabaseSync`
  alongside the store's. Separate connections do not share a transaction or a
  lock, so a coordination or provider write could block or fail the store's
  writer with `SQLITE_BUSY` instead of being serialised in process. Both now use
  the store's handle. Stopping cluster coordination no longer closes it.
- **`chownTree` recursed once per directory level** while re-owning a workspace,
  so a deep tree could overflow the stack during sandbox preparation. It now
  walks iteratively.
- **The Node version had three disagreeing sources of truth.** CI installed a
  floating `24`, the runtime image pinned `24.19.0`, and `packageManager`
  declared `npm@10.8.2`, which Node 24 does not ship and which nothing enforced
  because no workflow enables corepack. CI now reads `.nvmrc`, `engines` matches
  the image, and the unenforced npm pin is gone.
- **Any tool name the model invented became a permanent metrics series.**
  Per-tool counters were labelled with the name the model supplied, and that
  label was validated only for shape, so a call to a tool that does not exist
  still reached telemetry: the dispatcher rejects an unknown tool by returning a
  failed tool result, not by aborting the turn. A model that hallucinates tool
  names therefore grew the Prometheus label set without bound, inflating every
  scrape payload and the time-series database for the lifetime of the process.
  Tool labels are now restricted to the names the runtime actually defines;
  everything else is counted under `other`.
- **Deleting a session leaked its sandbox preparation cache.** Removing a
  session tears down the running turn, the sandbox processes, the workspace
  watcher, the chat row, the workspace directory, the preview tokens, the agent
  state, and the event ring, but the `preparedSandboxes` entry keyed by that
  session survived all of it. The map grew by one entry per session for the
  lifetime of the process, and a workspace later recreated under the same id
  would skip the ownership walk that the cache exists to record. The delete path
  now releases the entry through the new `forgetPreparedSandbox`.
- **A crash in any supporting process was silent, and one of them leaked
  browsers.** The API server records an unhandled rejection or an uncaught
  exception as a structured fatal event and then exits for a clean restart, but
  the executor, the browser controller, the browser worker, and the egress proxy
  installed no such handlers, so a fault in any of them surfaced only as an
  unexplained restart. The worker case was more than cosmetic: dying without
  running `closeAllBrowserSessions` orphaned the Chromium processes it had
  spawned, which survived as untracked children holding memory and profile
  directories. All four now emit the same fatal record, release what they own —
  sandboxed children, per-session workers, tunnelled sockets, browser sessions —
  and exit non-zero so the supervisor restarts them. A test holds every one of
  them to that contract.
- **The two slowest tools showed nothing at all until they finished.** Tool
  cards render live output from `state.metadata.output`, and the runtime hands
  every tool an `onOutput` callback for exactly that purpose, but only the shell
  family ever used it. `ssh_tool` was the sharper case: it already reported
  stdout and stderr chunk by chunk and accepted an `onOutput` parameter, yet
  nothing was ever passed to it, so the callback was dead code and a remote
  session stayed blank until it ended. `git` had no callback at all, which hid
  the progress that `clone`, `fetch`, and `pull` write to stderr. Both now feed
  the same coalescing buffer `bash` uses, so a card updates about four times a
  second instead of once per output chunk, and the buffer is stopped when the
  command ends. A test drives a real `git` process and asserts output arrives
  while the command is still running.

### Added

- `tests/tool-surface.test.mjs`, which fails if a tool the dispatcher can
  execute is not advertised to the model, if the `question` schema drifts from
  what the runtime and UI parse, if a subagent gains the ability to interrupt
  the user, if any module other than the store opens a SQLite handle in the
  long-lived server process, if streamed text regresses to per-delta writes, if
  a tool name invented by the model can open a new Prometheus series, or if
  deleting a session stops releasing one of its per-session caches.
- `.nvmrc`, pinning the Node version used by CI and the runtime image.
- This changelog.

### Removed

- `server/native/tools/registry.mjs`. It exported a parallel tool registry that
  nothing populated and nothing read; the real registry is `definitions.mjs`
  plus `dispatcher.mjs`. Its re-export from the barrel is gone with it.

### Changed

- `tests/config.test.mjs` points `Z_AGENT_DATA_DIR` at a scratch directory
  before importing runtime modules, so reading a constant no longer touches the
  developer's database.
