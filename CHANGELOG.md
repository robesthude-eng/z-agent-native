# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`1.0.0` predates this file and is the baseline; entries below describe changes
made on top of it.


## Stable user message widths

- Fixed short user messages such as “Привет” wrapping inside an excessively narrow bubble after the action row became icon-only. The width limit now resolves against the full message column, preserving the right-aligned compact style.
- Added browser coverage for narrow screens, 200% text scaling, intentional newlines, long unbroken URLs and reloaded history.

## Live isolated tool output

- Added bounded, throttled stdout/stderr snapshots over executor IPC, feeding running command, test and Git cards before execution completes. Legacy JSON and synchronous calls remain compatible.
- Running empty cards now say they are waiting for output rather than claiming there is none. Captured output inside shell command substitution still becomes available only when the shell prints it.
- Added streaming, UTF-8, cancellation, disconnect, output-bound and card regressions. Accepted commands are not retried after an IPC disconnect.

## Preserve normal research replies

- Fixed normal assistant replies being replaced with a model-unavailable notice when they contain OpenCode URLs, model JSON examples or quoted error text. Provider-error sanitization now stays within structured errors. Existing saved answers are preserved.
- Added component and end-to-end regressions for Markdown links, request examples and reloading saved replies.

## Release-ready chat controls

- Replaced the glowing terminal agent indicator with a restrained activity dot, an evidence-based status and elapsed time. Removed the empty “no external actions” subtitle.
- User messages now expose only copy/edit icons; removed the branching action from chat UI. Assistant retry remains an icon-only control. Accessible names, tooltips and 44px hit targets are preserved.

## Readable agent chat

- Self-hosted Inter with Cyrillic support, larger chat text, calmer spacing and clearer Markdown hierarchy. Font size continues to follow accessibility preferences.
- Readable compact tool disclosures; reasoning stays collapsed until explicitly opened. Turn metadata is a single expandable line rather than a duplicate result card.
- Response instructions distinguish completed work from verified results and favor outcome-first, readable answers without repetitive file lists.

## Tab-free workspace

- Removed the redundant Preview / Files / Code workspace navigation. The workspace opens on its file list, text files open directly in the embedded code editor, and closing the editor returns to files.
- Kept page preview in the top bar and preserved media viewers, file search, editing and unsaved-change confirmation.

## Compact workspace search

- Replaced workspace create-file/create-folder/upload buttons with a search icon; refresh and close remain.
- Search expands within the header from its center with a brief split-light reveal, focuses immediately, and closes on outside tap, its close button or Escape. Closing resets the file filter.
- Search opens the Files tab from preview/code. Reduced-motion users receive an instant reveal without light effects.

## Large-workspace file listing fix

- Recursive listings no longer silently stop at 10,000 entries and hide root files behind large dependency folders. Incomplete trees trigger complete root/expanded-directory listing instead.
- Read failures are no longer disguised as empty directories; symlink targets remain excluded.

## Workspace interface refresh

- Neutral Arena-inspired chat layout with history on the left and files, preview and code in the right workspace. Preview/editor no longer covers the conversation.
- Bold composer plus opens file/photo attachments, per-chat skills and web-search controls; the shared skill library remains in Settings.
- Send and stop share a compact 28px visible disc with a 44px hit target. Removed decorative composer glow and spinning stop ring.
- Per-chat web-search restrictions persist through draft materialization and durable turn recovery. They cannot grant tools disabled by server policy.
- Responsive menus, keyboard-accessible workspace tabs, modal skill selection and readable light-theme code highlighting.

## Full-access default (single-user administrator)

- `.env.example` / `prod:env:init` now default to the trusted unrestricted profile via `COMPOSE_FILE` (Internet, websearch, browser, SSH, installers, terminal, sudo, credential files).
- New `docker-compose.unrestricted.yml`: executor without `no-new-privileges`/read-only rootfs/capability drop, larger CPU/RAM/PID/file caps.
- `server/executor.mjs`: with `Z_AGENT_ALLOW_SUDO=1` session UIDs are registered in passwd/group/shadow and launched without `--no-new-privs`, so passwordless `sudo` actually works.
- Image ships `sudo` with a NOPASSWD rule (inert under the hardened profile).
- `Caddyfile` hostname comes from `Z_AGENT_DOMAIN` (default `localhost`).
- Removed the agentwill.online production `Deploy` and `Server Terminal` workflows (that host no longer exists).
- Browser: public sites no longer fail with `ERR_BLOCKED_BY_CLIENT` (DNS is resolved by browser-egress).
- UI: Stop button restyled to match the composer (neutral circle + spinning progress ring instead of red glow); assistant text uses a calmer `oc-prose` typography (softer contrast, 1.72 line height, quieter headings, styled tables/quotes/links).
- Browser `screenshot`/`pdf` without `url` capture the already-open page instead of failing with "requires html or url".
- Intent gate: a tool-less reply that ends on an announced next step ("Let me close the browser…", "Сейчас запущу тесты") is not accepted as final; the model is nudged (max 2 per turn) to act or answer.

## [Unreleased]

A stability pass. No capability was added to or removed from the product
surface; every change below either fixes a defect, removes unreachable code, or
makes an existing guarantee enforceable.

### Fixed

- **The agent closed a turn in the middle of a task.** A provider stream that
  dropped after the first tokens was returned as a complete answer; a response
  cut by the output-token limit was treated as final; the turn-level retry
  covered only network errors and its counter accumulated over the whole turn;
  the first loop-guard hit stopped the turn immediately; the default step budget
  (36) ended ordinary tasks with "step limit reached". Now an interrupted or
  truncated answer is continued in the same turn, transient provider errors
  (network, 429, 5xx, stream timeout) are retried per step, the loop guard warns
  the model once before stopping, the model is reminded when its own todo plan
  still has unfinished items, and the default budget is 64/96/128 steps. A
  subagent that hits its step limit now returns a summary of its findings.
- **The UI marked a long turn as "state not confirmed" after 15 minutes** even
  while the server reported it running; the watchdog is now re-armed by every
  running/waiting verdict. A completed verdict of the previous turn can no
  longer close the new one, and proxy errors (502/504/52x, HTML error pages) on
  the long `POST /message` no longer remove the user's message while the turn
  keeps running on the server.
- **The agent's question card was unreadable in the light theme** (hard-coded
  dark background with theme-coloured text; option labels were invisible).
- **Clicking a fresh "New chat" in the sidebar deleted it** (its history request
  returned 404 and was treated as a dead session).
- `/api/ui-config` is served only after authentication, as the e2e contract
  requires.

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

- **The question card answered on the user's behalf.** The card shown when the
  agent asks a blocking question paged between questions without recording the
  current selection, and the final submit filled every gap with a confident
  `skip`. Answering only the last of three questions sent two fabricated
  refusals, and the agent could not tell them from deliberate ones. Navigation
  now stores the draft answer, and submitting with a gap returns to the first
  unanswered question instead of inventing a reply. The skip button had the
  same problem from the other side: it sent the literal string `skip` as a
  normal answer, indistinguishable from a user who typed that word. It now
  calls the reject path the runtime already implemented, which marks the
  question rejected and releases the suspended turn. Option identity was
  derived from the option's own label, so two options sharing a label
  highlighted together and collided as React keys, while an option with no
  label rendered as a blank clickable row, because the `??` guards could never
  fire against the empty string the parser returns. Identity is now positional
  and a missing label falls back to a numbered placeholder. The card's
  remaining English strings now come from the message catalogue like the rest
  of the interface, and the option list exposes radiogroup and radio roles with
  `aria-checked` rather than signalling selection by colour alone.

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
