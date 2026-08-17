# opencode-plugin Specification

## Purpose

TBD - created by archiving change add-opencode-plugin. Update Purpose after archive.

## Requirements

### Requirement: Plugin source location

The plugin SHALL live in this monorepo at `apps/plugin/.opencode-plugin/`, sibling to `apps/plugin/.claude-plugin/`, `apps/plugin/.codex-plugin/`, `apps/plugin/.hermes-plugin/`, and `apps/plugin/.pi-plugin/`. The directory SHALL contain exactly four files at the top level: `plugin.ts`, `install.sh`, `uninstall.sh`, `README.md`. A co-located test file `plugin.test.ts` MAY exist alongside `plugin.ts` for vitest-based unit testing; the test file is NOT distributed to users.

The plugin SHALL NOT carry its own copy of the dotenv parser, slug regex, or `readRembricSlug` function, nor of any cross-client session-protocol logic (nudge strings, `<private>` redaction, truncation, the stderr diagnostic, the session HTTP client, the transcript accumulator, the summary-body builder, the flush helpers). Those live in two shared modules under `apps/plugin/bin/`, each the single source of truth for its area: `rembric-dotenv.mjs` (slug parsing, shipped by `apps/plugin/mcp-bridge/`) and `rembric-plugin-core.mjs` (session protocol, also consumed by the Pi client). `plugin.ts` imports from both via relative paths at source time (`../mcp-bridge/rembric-dotenv.mjs`, `../bin/rembric-plugin-core.mjs`); `install.sh` rewrites **each** path to its absolute installed location before copying.

There SHALL NOT be a `apps/plugin/.opencode-plugin/plugin.json`, `apps/plugin/.opencode-plugin/manifest.yaml`, or `apps/plugin/.opencode-plugin/helpers.ts` file. opencode has no plugin manifest format; plugins are JS/TS modules in a known directory, identified only by their exported `Plugin` function.

#### Scenario: Plugin tree contains the four files

- **WHEN** the repository is at HEAD
- **THEN** `ls apps/plugin/.opencode-plugin/` lists `plugin.ts`, `install.sh`, `uninstall.sh`, and `README.md`
- **AND** there are no nested directories under `apps/plugin/.opencode-plugin/`
- **AND** there is no `plugin.json`, `plugin.yaml`, `manifest.*`, or `helpers.ts` file

#### Scenario: Co-located test file is permitted

- **WHEN** the repository is at HEAD and unit tests exist for the plugin
- **THEN** `apps/plugin/.opencode-plugin/plugin.test.ts` MAY exist
- **AND** the install script SHALL NOT copy `plugin.test.ts` to the user's machine

#### Scenario: Both shared modules are imported, neither is copied

- **WHEN** `apps/plugin/.opencode-plugin/plugin.ts` is read at HEAD
- **THEN** it contains an import referencing `../mcp-bridge/rembric-dotenv.mjs` and an import referencing `../bin/rembric-plugin-core.mjs`
- **AND** it declares no local `stripPrivateTags`, no local nudge string constant, and no local session-POST helper

### Requirement: Shared dotenv lib SHALL be the single source of truth for slug parsing

The repository SHALL contain a shared dotenv module exporting exactly: `parseDotenv(content: string)`, `readRembricSlug(directory: string)`, and `SLUG_RE`. This module SHALL be the only place where the slug regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` and the dotenv parser live in JS/TS form across the entire repository.

Its canonical location SHALL be `apps/plugin/mcp-bridge/rembric-dotenv.mjs`. It moved there from `apps/plugin/bin/` because slug resolution became the published bridge's job, so the module must ship inside the bridge's tarball; the property that matters — **exactly one** JS/TS implementation — is unchanged, only its address is. A copy left behind at the old path would be the second implementation this requirement exists to forbid.

`apps/plugin/.opencode-plugin/plugin.ts` and `apps/plugin/.pi-plugin/index.ts` SHALL import `readRembricSlug` from `../mcp-bridge/rembric-dotenv.mjs`. The bridge SHALL import `parseDotenv` and `SLUG_RE` from `./rembric-dotenv.mjs`. No client file SHALL define its own copy of these helpers.

Bash (`apps/plugin/scripts/_api.sh::rembric_parse_dotenv` and `::rembric_read_project_slug`) and Python (`apps/plugin/.hermes-plugin/__init__.py::_SLUG_RE`) clients keep their own implementations because cross-language wrapping a 20-line parser costs more than the duplication. Those implementations MUST agree on the regex.

An invariant test in `apps/server/src/test/invariants.test.ts` SHALL fail the build if any JS/TS file under `apps/plugin/` declares its own `parseDotenv` function or `SLUG_RE` constant. The scanned set SHALL be every JS/TS source file under `apps/plugin/` — not only client files — so a non-client artefact such as the bridge is covered by contract rather than by the incidental reach of a glob. The invariant test SHALL reference the canonical path in its assertions, and moving the module SHALL therefore require updating that reference in the same change.

The set of files the invariant scans SHALL be **derived by a repository-wide search**, not hard-coded, and the invariant SHALL assert a **non-zero** scanned-file count. A hard-coded two-file list does not scan a client added later, and a negative assertion over an empty list passes vacuously — both were true of the version this requirement replaces.

Any tracked file that names the module's path as a literal SHALL be updated in the same commit as the move. At minimum this covers the invariant test's path constants, `scripts/pi-package.mjs`'s packable-import pattern (which matches a `bin/` prefix literally and would reject the new specifier as stray), and the opencode install script's fetch URL, `sed` rewrite and post-rewrite guard.

#### Scenario: Shared dotenv lib exists and exports the canonical helpers

- **WHEN** the repository is at HEAD
- **THEN** `apps/plugin/mcp-bridge/rembric-dotenv.mjs` exists and `apps/plugin/mcp-bridge/rembric-dotenv.mjs` does not
- **AND** it exports `parseDotenv`, `readRembricSlug`, and `SLUG_RE` as named exports
- **AND** `SLUG_RE.source` equals `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`

#### Scenario: Bridge and opencode plugin both import from the shared lib

- **WHEN** the repository is at HEAD
- **THEN** the bridge's slug resolution contains an import statement referencing `./rembric-dotenv.mjs`
- **AND** `apps/plugin/.opencode-plugin/plugin.ts` contains an import statement referencing `../mcp-bridge/rembric-dotenv.mjs`
- **AND** neither file contains a local `function parseDotenv` or `SLUG_RE = /`

#### Scenario: Every other JS/TS consumer imports from the shared lib too

- **WHEN** the repository is at HEAD
- **THEN** every JS/TS file the invariant scans that needs slug parsing SHALL import the shared dotenv module
- **AND** none SHALL contain a local `function parseDotenv` or `SLUG_RE = /`
- **AND** the scanned set SHALL include `apps/plugin/.pi-plugin/index.ts` and the bridge's sources

#### Scenario: The module ships in the published tarball

- **WHEN** `npm pack --dry-run` runs for `@rembric/mcp-bridge`
- **THEN** the file list SHALL include `rembric-dotenv.mjs`
- **AND** the assertion SHALL fail if it is absent, rather than publishing a package whose slug resolution cannot load

#### Scenario: Invariant test catches drift

- **GIVEN** a future change introduces a local `function parseDotenv` inside any JS/TS file under `apps/plugin/`
- **WHEN** `pnpm vitest run apps/server/src/test/invariants.test.ts` runs
- **THEN** the test FAILS with a message naming the offending file

#### Scenario: The invariant scans a derived, non-empty file list

- **WHEN** the invariant runs
- **THEN** its scanned-file list SHALL be derived from a repository-wide search over `apps/plugin/`
- **AND** the test SHALL fail if that list is empty, before evaluating any negative assertion

### Requirement: Plugin module exports a Plugin function

`apps/plugin/.opencode-plugin/plugin.ts` SHALL export a named const `RembricPlugin` typed as `Plugin` (from `@opencode-ai/plugin`). The export SHALL be an async function that receives the opencode plugin context (`{ project, client, $, directory, worktree }`) and returns an object whose properties are the event handler subscriptions.

The plugin module SHALL be importable in a Node/Bun environment that has `@opencode-ai/plugin` available as a peer dependency. The repository SHALL NOT add `@opencode-ai/plugin` to its own `dependencies` or `devDependencies` — it is consumed only at the user's runtime when opencode loads the plugin file.

A version comment of the form `// @rembric-plugin-version <semver>` SHALL appear in the first five lines of `plugin.ts`, wrapped on the line above and below by `// x-release-please-start-version` and `// x-release-please-end` (release-please's standard annotation for updating arbitrary text in non-package files). opencode has no manifest to declare a version; the comment is the only place to record it for diagnostics, and the `x-release-please-*` wrappers are what let the unified `plugin` release-please component find and update the version via its `extra-files` generic updater (in lock-step with the other clients — every client shares the one `plugin` version).

#### Scenario: Plugin file declares its version

- **WHEN** the file is read at HEAD
- **THEN** one of the first five lines matches `^// @rembric-plugin-version \d+\.\d+\.\d+$`
- **AND** the captured version equals the most recent `plugin-vX.Y.Z` git tag

#### Scenario: Plugin module loads under Bun

- **WHEN** Bun resolves `~/.config/opencode/plugins/rembric.ts` at opencode startup with `@opencode-ai/plugin` available
- **THEN** the import succeeds without error
- **AND** the exported `RembricPlugin` is an async function
- **AND** calling `RembricPlugin(ctx)` returns a Promise whose resolved value is a plain object with event-handler properties

#### Scenario: Version is managed by the unified plugin release-please component

- **WHEN** a commit modifies any file under `apps/plugin/`
- **THEN** the unified `plugin` component SHALL stage a version bump for the `// @rembric-plugin-version` comment in `plugin.ts` (alongside every other client carrier)
- **AND** every client SHALL share the one `plugin` version (independent only of `server`)
- **AND** a `plugin-vX.Y.Z` git tag SHALL be created when the release-please PR is merged

### Requirement: MCP transport spawns the published bridge through the config hook

The plugin's `config` hook SHALL configure `mcp.rembric` in memory with `type: "local"`, `command: ['npx', '-y', '@rembric/mcp-bridge@<plugin version>']`, the environment references `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN`, and `enabled: true`. When an entry already exists, it SHALL replace only its in-memory command and preserve its other values and unrelated entries. When no entry exists, the hook SHALL add this default entry in memory. The hook SHALL never write `opencode.json`.

`<plugin version>` SHALL be an exact pin equal to `apps/plugin/package.json::version`. The command SHALL contain no URL, header, or `--allow-http` argument. The installer SHALL explain that the hook owns the in-memory entry, SHALL NOT write `opencode.json`, and SHALL not copy or remove a legacy launcher. It SHALL fetch the moved dotenv module from `apps/plugin/mcp-bridge/` and `rembric-plugin-core.mjs` from `apps/plugin/bin/`; local iteration SHALL support `MCP_BRIDGE_SRC` alongside `PLUGIN_SRC` and `BIN_SRC`. The plugin SHALL NOT use `type: "remote"` for its Rembric entry.

#### Scenario: Existing launcher configuration is upgraded in memory

- **GIVEN** `mcp.rembric.command` names `node` and a legacy `rembric-bridge.mjs` path
- **WHEN** opencode invokes the plugin's `config` hook
- **THEN** the in-memory command SHALL be `['npx', '-y', '@rembric/mcp-bridge@<plugin version>']`
- **AND** the environment and all unrelated config values SHALL be unchanged
- **AND** `opencode.json` SHALL not be written

#### Scenario: An absent MCP entry is added only in memory

- **GIVEN** a config with no `mcp.rembric` entry
- **WHEN** the config hook runs
- **THEN** it SHALL add an in-memory local entry using the exact pinned bridge command and the two credential environment placeholders
- **AND** `opencode.json` SHALL not be written

#### Scenario: The hook pin is exact

- **WHEN** the config hook is run at a plugin version
- **THEN** its command SHALL contain exactly `@rembric/mcp-bridge@<plugin version>`
- **AND** it SHALL contain no URL, `--header`, or `--allow-http` argument

#### Scenario: The bridge package is used without a sibling implementation

- **WHEN** the plugin tree is inspected
- **THEN** no opencode-specific stdio-to-HTTP bridge implementation or maintained launcher SHALL exist
- **AND** the config hook SHALL use the published bridge package

### Requirement: Slug resolution uses the .rembric convention shared across clients

The bridge spawned by opencode SHALL resolve the project slug by reading `<cwd>/.rembric` and parsing `PROJECT_SLUG=<slug>` from dotenv-style lines (mirroring `_api.sh::rembric_read_project_slug` and the published `mcp-bridge` contract).

The plugin's runtime event handlers (that POST directly to `/api/<slug>/sessions/...` over HTTP, bypassing MCP) SHALL call `readRembricSlug(ctx.directory)` from `apps/plugin/mcp-bridge/rembric-dotenv.mjs` — the same function the bridge uses. This guarantees byte-identical resolution semantics (same dotenv grammar, same regex, same fail-silent miss behaviour) without duplicating the implementation.

The plugin SHALL NOT fall back to git-remote-derived slugs, `package.json::name`, or repository-directory basename. If `.rembric` is missing or the slug is invalid, `readRembricSlug` returns `null`, the plugin's `disabled || !slug` short-circuit fires inside `rembricPost`, and lifecycle POSTs are skipped silently (one stderr diagnostic line emitted at plugin startup when the env vars are present but slug resolution fails).

#### Scenario: Plugin reads .rembric for HTTP lifecycle calls

- **GIVEN** opencode running in `/home/user/repo-a` with `/home/user/repo-a/.rembric` containing `PROJECT_SLUG=repo-a`
- **WHEN** the plugin's `session.created` handler fires
- **THEN** the handler reads `/home/user/repo-a/.rembric`
- **AND** validates `repo-a` against `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`
- **AND** POSTs to `${REMBRIC_SERVER_URL}/api/repo-a/sessions` with `Authorization: Bearer ${REMBRIC_API_TOKEN}`

#### Scenario: Plugin no-ops cleanly when .rembric is missing

- **GIVEN** opencode running in `/home/user/no-rembric-here` with no `.rembric` file
- **WHEN** the plugin's `session.created` handler fires
- **THEN** the handler writes one stderr line of the form `[rembric] no project slug for session <id>; skipping session POST`
- **AND** SHALL NOT POST to any `/api/*` endpoint
- **AND** SHALL NOT throw or reject

#### Scenario: Plugin no-ops cleanly when slug is invalid

- **GIVEN** `.rembric` containing `PROJECT_SLUG=-leading-hyphen-invalid`
- **WHEN** the plugin's `session.created` handler fires
- **THEN** the handler writes one stderr line indicating the slug did not match the regex
- **AND** SHALL NOT POST to any `/api/*` endpoint

#### Scenario: TypeScript readRembricSlug matches bridge byte-for-byte

- **GIVEN** a test fixture `.rembric` containing trailing-whitespace variants, `#`-prefixed comment lines, quoted values, and `PROJECT_SLUG=valid-slug`
- **WHEN** the unit test calls `readRembricSlug('<fixtureDir>')` AND calls the bridge's dotenv parser on the same file
- **THEN** both return the same slug value

### Requirement: Event handler set

The plugin module's returned object SHALL declare exactly the following event handler properties, no more and no fewer:

1. `event: async ({ event }) => ...` — a dispatcher that switches on `event.type` for `"session.created"`, `"session.deleted"`, `"server.instance.disposed"`, `"message.updated"`, `"message.part.updated"`, and `"session.idle"`. Any other `event.type` values SHALL be silently ignored. None of these five are top-level `Hooks` object keys in the opencode plugin API; all are members of the `Event` union delivered exclusively through this dispatcher.
2. `"chat.message": async (input, output) => ...` — appends a `{role:'user', text}` entry to the per-session transcript accumulator (`sessionMessages` Map). The handler SHALL NOT POST any HTTP request.
3. `"experimental.session.compacting": async (input, output) => ...` — post-compaction reminder injection.

The plugin SHALL NOT register `"tool.execute.after"`. The corresponding `/api/<slug>/observations/passive` endpoint does not exist on Rembric's HTTP API; the handler has no work to do.

The plugin SHALL NOT register `experimental.chat.system.transform` (no system-prompt injection). The plugin SHALL NOT register `tool.execute.before` (no tool guards). The plugin SHALL NOT register `permission.asked` or `permission.replied`.

If Plan B of the cwd spike applies (see "cwd spike" requirement), the plugin SHALL additionally register `"shell.env": async (input, output) => { output.env.REMBRIC_PROJECT_DIR = ctx.directory }`. The hook SHALL be omitted otherwise.

The `chat.message` handler and the `event` dispatcher's `message.updated`/`message.part.updated`/`session.idle` branches MUST treat the `sessionMessages` Map (plus the `messageRoles`/`assistantParts` accumulators for the message branches, and the debounce-timer map for `session.idle`) as their only side effects beyond the deliberate HTTP POST each performs. An invariant test (`apps/server/src/test/invariants.test.ts`) SHALL fail the build if the `chat.message` handler invokes `rembricPost`, `fetch`, or any other HTTP work (the `event` dispatcher's `message.updated`, `message.part.updated`, and `session.idle` branches are exempted from this specific invariant since `session.idle`'s HTTP POST is the intended primary flush mechanism — see "Session.idle handler (periodic flush)").

#### Scenario: Handler set is exactly the documented set

- **WHEN** the resolved value of `RembricPlugin(ctx)` is inspected
- **THEN** its own enumerable keys are exactly `["event", "chat.message", "experimental.session.compacting"]` plus `"shell.env"` if Plan B is active
- **AND** no other keys exist — in particular, `"message.updated"`, `"message.part.updated"`, and `"session.idle"` SHALL NOT appear as top-level keys

#### Scenario: message.updated, message.part.updated, and session.idle events reach the event dispatcher

- **WHEN** opencode emits an event of type `"message.updated"`, `"message.part.updated"`, or `"session.idle"`
- **THEN** the plugin's `event` hook SHALL receive it (none has its own top-level `Hooks` key) and route it to the corresponding branch described in "Message.updated handler tracks role" / "Message.part.updated handler accumulates assistant transcript" and "Session.idle handler (periodic flush)"

### Requirement: Session.created handler with sub-agent filtering

The `event` dispatcher's `"session.created"` branch SHALL extract `event.properties.info.id`, `event.properties.info.parentID`, and `event.properties.info.title`. It SHALL treat a session as a sub-agent (and skip top-level registration) iff `parentID` is truthy OR `title.endsWith(" subagent)")`. Sub-agent session IDs SHALL be stored in a closure-scoped `Set<string>` named `subAgentSessions` so subsequent `tool.execute.after` events for the same id can also skip work.

Non-sub-agent sessions SHALL be registered exactly once per plugin lifetime via an `ensureSession(id)` helper — supplied by the shared core, not reimplemented here (`plugin-session-protocol`) — that:

- Returns immediately if `id` is empty.
- Returns immediately if `id` is in `subAgentSessions`.
- Returns immediately if `id` is already in `knownSessions` (a second closure-scoped `Set<string>`).
- Adds `id` to `knownSessions`.
- POSTs `${REMBRIC_SERVER_URL}/api/<slug>/sessions` with body `{"id": <id>, "agent": "opencode", "cwd": <ctx.directory>}` if a slug resolved successfully. The body SHALL OMIT `cwd` entirely (NOT send `null`) when `ctx.directory` is unavailable, matching the bug fix recorded in memory `01KRY3ZAF86NRK5Y8K3N0JJ9M6`.
- POSTs `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<id>/resume` with body `{}` immediately afterwards, on this branch only.

The resume SHALL be issued on the newly-known branch and SHALL NOT be issued on any of the three early returns, so exactly one resume is sent per session id per plugin lifetime however many handlers call `ensureSession` for it. The plugin file SHALL NOT contain the resume path as a literal, for the same reason it contains no other `/sessions/…` fetch: the shared core is the single implementation of the session HTTP client.

The rule is unconditional. opencode emits `session.created` exactly once in the life of a session id — the host's `create` is idempotent and returns before the `publish` — and reopening a persisted session keeps its id and emits nothing, so there is no host signal here that could distinguish a reopened conversation from a new one even if the plugin wanted one. The unconditional resume is what makes a reopened opencode session re-attach: its row will normally be `abandoned`, since the plugin never POSTs `/end` and the sweep retires the row while the operator is away.

The handler SHALL emit one stderr diagnostic line per `session.created` event of the form `[rembric] session.created id=<id> parentID=<parentID|""> title=<title|""> subagent=<true|false>`. This is mandatory: it makes sub-agent heuristic drift visible in opencode's debug logs (design.md risk register).

#### Scenario: Top-level session is registered exactly once

- **WHEN** `session.created` fires with `info.id="abc"`, `info.parentID=""`, `info.title="Working on widget"`
- **THEN** `ensureSession("abc")` runs and POSTs to `/api/<slug>/sessions` exactly once
- **AND** a second `session.created` with the same id is a no-op (no second POST)

#### Scenario: The resume follows the ensure exactly once per id

- **WHEN** `ensureSession("abc")` runs for the first time in this plugin lifetime
- **THEN** it SHALL POST `/api/<slug>/sessions` and then `/api/<slug>/sessions/abc/resume`, in that order
- **AND** a `chat.message` or `experimental.session.compacting` event for the same id afterwards SHALL POST neither
- **AND** the control SHALL pass in the same run: `ensureSession("def")` for an id not yet known DOES POST both

#### Scenario: A reopened opencode session re-attaches its memories

- **GIVEN** session `abc` was registered in a previous opencode process, and its row is now `abandoned` because the plugin never posts `/end` and the sweep retired it
- **WHEN** the operator reopens that conversation, opencode emits `chat.message` for the same id, and `ensureSession("abc")` runs for the first time in the new process
- **THEN** the ensure SHALL return the row still `abandoned`, and the resume that follows SHALL return it to `status='active'` with `ended_at IS NULL`
- **AND** a subsequent `memory.save` on that conversation's MCP transport SHALL persist a non-null `session_id`
- **AND** the control SHALL pass in the same run: without the resume the row stays `abandoned` and the same save persists `session_id = NULL`

#### Scenario: A sub-agent session is neither ensured nor resumed

- **WHEN** `session.created` fires with `info.parentID="parent-1"`
- **THEN** neither `/api/<slug>/sessions` nor `/api/<slug>/sessions/<id>/resume` SHALL be POSTed
- **AND** the id SHALL be in `subAgentSessions`

#### Scenario: Sub-agent session is filtered

- **WHEN** `session.created` fires with `info.id="abc"`, `info.parentID="parent-1"`, `info.title="Implement step (codex subagent)"`
- **THEN** `subAgentSessions` contains `"abc"`
- **AND** NO POST to `/api/<slug>/sessions` occurs
- **AND** the stderr diagnostic includes `subagent=true`

#### Scenario: Sub-agent detection by title suffix without parentID

- **WHEN** `session.created` fires with `info.id="def"`, `info.parentID=""`, `info.title="Verify rebuild (subagent)"`
- **THEN** the title-suffix heuristic matches (` subagent)` literal)
- **AND** `def` is added to `subAgentSessions`
- **AND** no top-level POST occurs

#### Scenario: cwd is omitted from body when ctx.directory is empty

- **GIVEN** `ctx.directory` is the empty string at plugin construction time
- **WHEN** `ensureSession("xyz")` POSTs to `/api/<slug>/sessions`
- **THEN** the JSON body is `{"id": "xyz", "agent": "opencode"}` with NO `cwd` key
- **AND** the body MUST NOT contain `"cwd": null`

### Requirement: Session.deleted handler clears in-memory state only

The `event` dispatcher's `"session.deleted"` branch SHALL remove the session id from `knownSessions`, `subAgentSessions`, and `sessionMessages` (the per-session transcript accumulator). It SHALL NOT POST any HTTP request. opencode's `session.deleted` fires only on explicit UI delete — it is not a "user quit" signal and SHALL NOT trigger server-side session closure.

Server-side session closure SHALL rely on:

- The agent voluntarily calling `memory.session_summary` (cooperating path; sets `summary_final=true`, locking the row against transcript-based overwrites).
- The dispose-flush at `server.instance.disposed` time, which POSTs the accumulated transcript via `/sessions/<id>/summary` with `final:false` (see "Server.instance.disposed flush handler"). Sets `summary` but leaves `status='active'` until `abandonStale` flips it.
- The server's `abandonStale` periodic task flipping `status='active'` rows to `'abandoned'` after the configured inactivity threshold.

#### Scenario: session.deleted is a local-state cleanup

- **GIVEN** session id `"abc"` is in `knownSessions` and `sessionMessages` contains an entry for `"abc"`
- **WHEN** `session.deleted` fires with `info.id="abc"`
- **THEN** `knownSessions` no longer contains `"abc"`
- **AND** `sessionMessages.has("abc")` is `false`
- **AND** no HTTP request is made
- **AND** the server's `sessions` table is NOT modified by this event

### Requirement: Experimental.session.compacting handler

The `"experimental.session.compacting"` handler SHALL:

1. If `input.sessionID` is present, call `ensureSession(input.sessionID)`.
2. Push a single string onto `output.context` (the array opencode's compactor consumes) instructing the post-compaction agent to FIRST read the stored summary with `memory.session_get`, and THEN call `memory.session_summary` with the session's CURRENT COMPLETE state — brought up to date with the surviving window, **and with the write's section-wise merge semantics stated: each `##` section the write carries replaces its stored counterpart and a section the write omits keeps its stored text, so sending the compacted window alone replaces every section the window happens to mention and leaves the rest silently stale.** The instruction text SHALL be a single multi-line string. The text SHALL name the project slug when one was resolved. **The text SHALL ALSO direct the post-compact agent to call `memory.context` if it needs detail beyond what it read (file paths, decisions, specific errors not in the compacted block). That escalation — not a data-loss warning — is the only fallback the text SHALL name.** It sits inside the numbered list rather than at the very end: the shared fixture closes by telling the agent to resume the user's request, and the pushed string is that fixture plus the slug sentence, so a requirement that the string END on the `memory.context` sentence would be unsatisfiable against the byte-identity requirement below.

**A dedicated sentence stating that skipping this step loses everything before compaction is NOT required, and SHALL NOT be added as the string's ending.** The risk it would state is already published by the merge clause above — the shared fixture says what a write does to each section, so a thin rewrite is understood to overwrite the sections it names and to leave the others behind — so the sentence buys nothing. And the string's ending is not available to it: the byte-identity requirement below fixes the protocol text as the shared fixture, which closes by telling the agent to resume the user's request, with only the per-connection slug sentence appended after that. A sentence added as the ending would break that byte-identity.

**The previous form of that rationale is corrected rather than merely reworded, and this change owns the correction.** It argued from `this REPLACES the stored value` — the fixture's own words at the time — and read "a thin rewrite overwrites the prior state". After `refine-session-summary-writes` that is true only of a rewrite carrying every stored heading. The danger is unchanged in kind and different in shape: a thin rewrite now overwrites what it names and silently ages what it omits, which is why the fixture's wording moves with the rationale rather than being left behind it.

**The instruction SHALL NOT ask the agent to call `memory.session_summary` with the content of the compacted summary**, and SHALL NOT ask for a summary of the surviving window. That was the shipped framing when this requirement was first rewritten — `apps/plugin/.opencode-plugin/plugin.ts:244-252` pushed "call `memory.session_summary` with the content of the compacted summary above." and then "This preserves what was accomplished before compaction." — and against a merging write it still produces loss, now as staleness rather than as replacement.

This handler was the one compaction surface the read-then-rewrite rewrite missed, and the reason is worth recording because it is a property of the guard rather than of the author: the enumeration that pins the model-facing summary surfaces (`apps/server/src/test/invariants.test.ts::'the session-summary rubric has one source'`) asserts its own completeness from a `git grep` for the canonical section list, and this block never carried that list, so it was never in the enumeration and no test could notice it disagreeing.

The obligations of "The post-compaction instruction SHALL direct the model to read the stored summary and then rewrite the session's current state in full" apply to this string in full; this handler is the opencode compaction surface named there.

**The protocol sentences SHALL NOT be hand-written in `plugin.ts`.** They SHALL be sourced from the shared cross-language fixture contract (`apps/plugin/test/nudge-fixtures.json`) through the shared JS/TS core (`apps/plugin/bin/rembric-plugin-core.mjs`) and pinned by `apps/plugin/test/nudge-fixtures.test.ts`, on the same single-implementation discipline every other model-facing line follows. The bash clients embed the `rembric:`-prefixed fixture value and this client embeds the unprefixed `…Core` variant; the unprefixed variant SHALL satisfy the same ≤600-byte budget the prefixed one carries under "Plugin-injected protocol nudges MUST surface the summary length cap", and **a reworded text SHALL be re-measured against it in the same commit** (measured on the shipped fixture after the merge correction: 599 bytes prefixed, **590 unprefixed**; 675/666 before it).

**The ≤600-byte budget binds the shared fixture value alone (`postCompactCore`), never the assembled per-connection string this handler pushes.** The slug sentence appended after it (`Use project: '<slug>'. `) is per-connection data, not protocol text, and its length is not fixed: `SLUG_RE` allows a slug up to 64 characters, and the sentence's own template costs on the order of 17-18 further bytes at a zero-length slug, so a slug somewhere past the low-30s of characters would put the ASSEMBLED string over 600 bytes if the cap were read that way. That is a bound the requirement never intended: measuring the fixture alone is the established convention for every other per-line cap in this contract. A future change that wants a ceiling on the assembled string MAY add one, but it SHALL do so explicitly and re-measure against `SLUG_RE`'s actual 64-character maximum rather than a short example slug.

The project-slug sentence remains this client's own addition and is appended to the shared text rather than forked from it: it is the only part of the string that is per-connection data rather than protocol text. A consequence worth stating: the shared text carries the `10000` cap substring, so this injection surfaces the cap even though the injection-site list in "Plugin-injected protocol nudges MUST surface the summary length cap" does not name `plugin.ts`.

The handler SHALL NOT mutate `input.context` or `input.messages` directly. All effects SHALL be expressed as appends to `output.context`.

The handler SHALL NOT GET any `/context` or recall-context endpoint — no such endpoint exists on the HTTP API today. When one ships, the handler MAY be extended to prepend a server-returned recall block before the reminder; that prepend SHALL fail silently on any error and the reminder string SHALL remain the last (always-present) entry.

#### Scenario: Reminder includes memory.session_summary AND memory.context guidance

- **WHEN** `experimental.session.compacting` fires with a valid `input.sessionID`
- **THEN** `ensureSession` runs (POST `/api/<slug>/sessions` once)
- **AND** exactly ONE string is pushed to `output.context`
- **AND** that string contains the substring `memory.session_summary`
- **AND** that string contains the substring `memory.context`
- **AND** that string contains the project slug when one was resolved from `.rembric`
- **AND** that string contains the substring `memory.session_get`, positioned before the `memory.session_summary` directive it is meant to precede

#### Scenario: The pushed string states the merge, not a whole-document replacement

- **WHEN** the string pushed onto `output.context` is inspected
- **THEN** it SHALL state that the `##` sections the write carries replace their stored counterparts and that omitted sections keep their stored text
- **AND** it SHALL NOT state that the write REPLACES the stored value without qualification

#### Scenario: Compacting fires without sessionID

- **WHEN** `experimental.session.compacting` fires with no `input.sessionID`
- **THEN** `ensureSession` SHALL NOT be called and no HTTP request SHALL be made
- **AND** the instruction string SHALL still be pushed onto `output.context`, unchanged in content

#### Scenario: The instruction carries no window-only framing

- **WHEN** the string pushed onto `output.context` is inspected
- **THEN** it SHALL NOT instruct the agent to pass the compacted summary's content, "the compacted summary above", or a summary of the surviving window to `memory.session_summary`

#### Scenario: The protocol text is the shared one, not a per-client copy

- **WHEN** `apps/plugin/.opencode-plugin/plugin.ts` is inspected
- **THEN** it SHALL NOT declare its own copy of the protocol sentences
- **AND** the sentences it pushes SHALL be byte-identical to the shared fixture's unprefixed post-compaction value, with the slug sentence as the only per-client addition

### Requirement: HTTP client behaviour

The plugin's HTTP client SHALL:

- Use native `fetch` (available in Bun ≥ 1.0).
- Send `Authorization: Bearer ${REMBRIC_API_TOKEN}` on every request.
- Send `Content-Type: application/json` on every request with a body.
- Use a 3-second timeout for lifecycle POSTs (`/sessions`, `/sessions/*/summary`, `/sessions/*/end`, `/prompts/passive`, `/observations/passive`) and a 5-second timeout for the compaction-time GET `/context`.
- On any HTTP error (network failure, timeout, non-2xx status), write a single stderr diagnostic line of the form `[rembric] <METHOD> <path> <status_or_error>` and return without throwing. NO RETRY in v1.
- Read `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from `process.env` at plugin construction time. If either is missing, the entire plugin SHALL no-op (every handler short-circuits) and a single stderr diagnostic SHALL be written at startup.

#### Scenario: Missing env vars short-circuit every handler

- **GIVEN** `REMBRIC_SERVER_URL` is unset when opencode loads the plugin
- **WHEN** `session.created` fires
- **THEN** no HTTP request is made
- **AND** one stderr diagnostic line was emitted at plugin startup

#### Scenario: HTTP error is silent

- **GIVEN** the server returns 503 for `POST /api/<slug>/sessions`
- **WHEN** `ensureSession("x")` runs
- **THEN** one stderr diagnostic line is written
- **AND** the handler returns normally without throwing
- **AND** `knownSessions` still contains `"x"` (we treat the POST as best-effort; the in-memory state advances regardless to prevent retry loops in v1)

### Requirement: Install script contract

The current install contract supersedes the copied-launcher details retained in
its historical scenarios below. `apps/plugin/.opencode-plugin/install.sh`
SHALL remain a POSIX `sh` script with `set -eu`; copy the plugin, the moved
bridge dotenv module, and `rembric-plugin-core.mjs`; verify every rewritten
shared import; print rather than write the MCP snippet; and never create,
modify, or delete `opencode.json`.

It SHALL fetch `rembric-dotenv.mjs` from
`apps/plugin/mcp-bridge/rembric-dotenv.mjs` and
`rembric-plugin-core.mjs` from `apps/plugin/bin/`. The printed command SHALL be
`['npx', '-y', '@rembric/mcp-bridge@<exact-version>']` with literal URL and
token placeholders. It SHALL not copy or remove the deleted repository
launcher; existing user-owned launcher files are handled by the config hook.
The moved dotenv source is required and its absence SHALL fail loudly.

#### Scenario: Idempotent re-run

The published scenario remains current for the shared files and installer
state; the launcher copy it formerly implied is superseded.

- **WHEN** `install.sh` runs twice in succession
- **THEN** both invocations exit 0
- **AND** every destination file exists after each invocation, including `rembric-plugin-core.mjs`
- **AND** their contents match the source files

#### Scenario: Snippet has expanded $HOME but unexpanded placeholders

The published path assertion is retained for MODIFIED-body provenance. Fresh
installs now print the pinned npx command, not a launcher path.

- **GIVEN** `$HOME = /Users/alice`
- **WHEN** the install script prints the MCP snippet
- **THEN** the snippet's `command` SHALL be the pinned `npx` form and SHALL contain no `/Users/alice` path — the title's first half describes the form this change replaces, and is kept because a published scenario title cannot be renamed inside a MODIFIED block
- **AND** the snippet contains the literal placeholders `<REMBRIC_SERVER_URL>` and `<REMBRIC_API_TOKEN>` (NOT substituted)

#### Scenario: Missing dotenv source aborts at its new path

- **GIVEN** `apps/plugin/mcp-bridge/rembric-dotenv.mjs` is absent
- **WHEN** `install.sh` runs
- **THEN** the script exits with a non-zero code
- **AND** writes a stderr message naming `apps/plugin/mcp-bridge/rembric-dotenv.mjs`, not the retired `apps/plugin/bin/` path

#### Scenario: A single unrewritten import aborts the install

The published scenario remains current; the two rewritten imports are the
moved dotenv module and the shared session-protocol core.

- **GIVEN** the installed plugin file references the absolute dotenv path but still carries the relative core import
- **WHEN** `install.sh` completes its rewrite verification
- **THEN** it SHALL exit non-zero naming the failed rewrite
- **AND** it SHALL NOT leave the broken plugin file at `${HOME}/.config/opencode/plugins/rembric.ts`
- **AND** the same SHALL hold with the two rewrites reversed — an absolute core path alongside a surviving relative `../mcp-bridge/rembric-dotenv.mjs` import

#### Scenario: An absent opencode.json remains absent

- **WHEN** the installer runs with no `${HOME}/.config/opencode/opencode.json`
- **THEN** the file SHALL remain absent
- **AND** stdout SHALL contain the exact pinned npx MCP snippet

#### Scenario: An existing opencode.json is byte-identical

- **WHEN** the installer runs with an existing `opencode.json`
- **THEN** its bytes SHALL be unchanged
- **AND** stdout SHALL contain the snippet for manual paste

#### Scenario: Missing bridge source aborts

- **GIVEN** `apps/plugin/mcp-bridge/rembric-dotenv.mjs` is absent
- **WHEN** `install.sh` runs
- **THEN** the script SHALL exit non-zero
- **AND** writes a stderr message naming `apps/plugin/mcp-bridge/rembric-dotenv.mjs`

### Requirement: Uninstall script contract

`apps/plugin/.opencode-plugin/uninstall.sh` SHALL:

1. Use `#!/usr/bin/env bash` shebang and `set -uo pipefail` (no `-e` — we want to continue past missing files).
2. Remove `${HOME}/.config/opencode/plugins/rembric.ts` if present.
3. Remove `${HOME}/.config/rembric/bin/rembric-bridge.mjs` if present.
4. Remove `${HOME}/.config/rembric/bin/rembric-dotenv.mjs` if present (the shared dotenv lib copied by `install.sh`).
5. Remove `${HOME}/.config/rembric/bin/rembric-plugin-core.mjs` if present (the shared session-protocol core copied by `install.sh`).
6. Remove `${HOME}/.config/rembric/bin/` if empty.
7. Remove `${HOME}/.config/rembric/` if empty.
8. Print a final banner listing what was removed and what was NOT removed (e.g., the MCP block in `opencode.json`, which the user must edit manually).
9. Exit 0 even if all targets were absent (idempotent).

The set of removal targets SHALL stay in agreement with the set of files `install.sh` copies: a file installed but never removed is residue the operator cannot discover.

The script SHALL NOT touch `~/.config/opencode/opencode.json`. The script SHALL NOT remove the `~/.config/opencode/plugins/` directory itself (it may contain other plugins).

#### Scenario: Idempotent uninstall

- **WHEN** `uninstall.sh` runs against a system where the plugin has already been removed
- **THEN** the script exits 0
- **AND** writes a banner indicating no targets existed

#### Scenario: opencode.json is preserved

- **WHEN** `uninstall.sh` completes
- **THEN** `~/.config/opencode/opencode.json` is unchanged
- **AND** the printed banner instructs the user to remove the `mcp.rembric` block manually

#### Scenario: Install and uninstall target sets agree

- **WHEN** the file lists in `install.sh` and `uninstall.sh` are compared
- **THEN** every file `install.sh` copies SHALL appear as a removal target in `uninstall.sh`
- **AND** the agreement SHALL be asserted by a test rather than reviewed by eye

### Requirement: cwd spike gates the plugin's shell.env hook

Before implementation begins, an operator-driven spike SHALL determine whether opencode spawns `type: "local"` MCP subprocesses with the user's repository as `cwd` or sets `PWD` to that directory. The spike steps are documented in tasks.md (phase 0).

The result determines which path ships:

- **Plan A (default)**: If opencode sets cwd or PWD to the user's repo, the bridge resolves the slug correctly via its existing `CLAUDE_PROJECT_DIR > PWD > process.cwd()` chain. The plugin SHALL NOT register `shell.env`. The bridge SHALL NOT change. The plugin SHALL NOT export `REMBRIC_PROJECT_DIR` anywhere.
- **Plan B**: If neither cwd nor PWD reaches the user's repo, the plugin SHALL register a `shell.env` hook that sets `output.env.REMBRIC_PROJECT_DIR = ctx.directory` on every subprocess opencode spawns. The published bridge SHALL gain a new highest-precedence step in its resolution chain: `REMBRIC_PROJECT_DIR > CLAUDE_PROJECT_DIR > PWD > process.cwd()`. The new step SHALL be additive: existing clients that never set `REMBRIC_PROJECT_DIR` SHALL retain their current behaviour unchanged.

The decision SHALL be recorded as a one-line comment near the top of `plugin.ts` of the form `// cwd-spike-result: plan-a` or `// cwd-spike-result: plan-b`. The comment SHALL match the implementation actually shipped.

#### Scenario: Plan A ships without bridge changes

- **GIVEN** the spike confirms opencode spawns subprocesses with the user's repo as cwd or PWD
- **WHEN** the implementation lands
- **THEN** `plugin.ts` contains `// cwd-spike-result: plan-a`
- **AND** `plugin.ts` exports no `"shell.env"` handler
- **AND** the published bridge retains its existing project-directory behaviour (its diff against the previous version is empty)

#### Scenario: Plan B ships with additive bridge change

- **GIVEN** the spike confirms opencode does NOT propagate the user's repo via cwd/PWD
- **WHEN** the implementation lands
- **THEN** `plugin.ts` contains `// cwd-spike-result: plan-b`
- **AND** `plugin.ts` exports a `"shell.env"` handler that sets `output.env.REMBRIC_PROJECT_DIR`
- **AND** the published bridge reads `REMBRIC_PROJECT_DIR` as the highest-precedence step of its resolution chain
- **AND** the bridge's behaviour when `REMBRIC_PROJECT_DIR` is unset is byte-identical to its pre-change behaviour

### Requirement: README documents the two-step install

`apps/plugin/.opencode-plugin/README.md` SHALL lead with the **TUI installer** as the primary install/upgrade path (the root `install.sh` shim, canonical URL `.../main/install.sh`, or `--agent=opencode`).

Below that, under an explicitly-labelled "Manual install" heading, the README SHALL document the manual install in exactly two steps in this order:

1. Run `bash install.sh` (or `curl ... | bash` shorthand if the operator publishes one).
2. Paste the printed MCP snippet into `~/.config/opencode/opencode.json` (or the project's `./opencode.json`), filling in `<REMBRIC_SERVER_URL>` and `<REMBRIC_API_TOKEN>`. Restart opencode.

The README SHALL include:

- An "Update" section explaining that opencode does not cache plugins by version, so updating means re-running the installer (the TUI's opencode update, or re-running `install.sh`, which overwrites the installed files).
- A "Verify" section showing how to confirm the install: opening opencode in a `.rembric`-equipped repo, opening a session, observing one `[rembric] session.created` stderr line in opencode's debug logs.
- A "Troubleshooting" section listing the three most likely failure modes: missing `.rembric` (plugin silently no-ops the session POST), missing env vars in the MCP block (bridge exits 1 and opencode shows a connection error), opencode version older than the supported floor (handler API mismatch).

The README SHALL NOT include an "npm install" path.

#### Scenario: README leads with the TUI, manual two-step follows

- **WHEN** the file is read top-to-bottom
- **THEN** the first install instruction SHALL be the TUI installer
- **AND** under a "Manual install" heading the two manual steps SHALL appear in order: step 1 (run install.sh) before step 2 (paste MCP snippet)
- **AND** no section mentions npm

### Requirement: Plugin version managed by the unified plugin release-please component

The version recorded in `apps/plugin/.opencode-plugin/plugin.ts`'s `// @rembric-plugin-version` comment SHALL track the single unified `plugin` release-please component (covering all of `apps/plugin/`, package `@rembric/plugin`, tag `plugin-vX.Y.Z`). opencode is NO LONGER a separate release-please component; its version carrier is updated by the `plugin` component via an `extra-files` generic updater on `plugin.ts` (between the `x-release-please-*` markers). There is no `node-workspace` plugin and no per-client component.

All plugin clients (claude, codex, opencode, hermes, pi) share the single `plugin` version — they never diverge. A client that is additionally published to a package registry does NOT get its own component or version line. Operators do NOT hand-edit version surfaces; Conventional Commits drive bumps via release-please.

#### Scenario: An opencode-scoped change bumps the unified plugin component

- **WHEN** a Conventional Commit touching `apps/plugin/.opencode-plugin/` lands on `main`
- **THEN** release-please SHALL open (or update) a release PR for the `plugin` component, bumping `plugin-vX.Y.Z` and writing the new version into the `// @rembric-plugin-version` comment (alongside every other client carrier)
- **AND** no separate `opencode-plugin` component / `opencode-plugin-v*` tag SHALL exist

#### Scenario: A shared-asset change bumps the one plugin version (all clients together)

- **WHEN** a Conventional Commit modifies a shared file under `apps/plugin/bin/` or `apps/plugin/scripts/`
- **THEN** release-please SHALL bump the single `plugin` component, and the opencode `// @rembric-plugin-version` comment SHALL move to the same new version as every other client
- **AND** the server image SHALL NOT be rebuilt (the `plugin` release does not trigger `publish-docker`)

### Requirement: Docs and dashboard help mention opencode

`README.md`, `docs/agents.md`, and the dashboard's connection-help copy (wherever Claude Code / Codex CLI / Hermes Agent are listed as supported clients) SHALL list "opencode" as a fourth supported client. The opencode entry SHALL link to `apps/plugin/.opencode-plugin/README.md` for setup instructions.

`docs/agents.md` SHALL gain an "opencode" section parallel in shape to the existing Claude / Codex / Hermes sections, structured as:

- **Install**: pointer to the install script.
- **Configure**: the MCP block snippet (or pointer to the install script's printed output).
- **Verify**: how to confirm a session was registered.
- **Troubleshooting**: common failure modes.

#### Scenario: docs/agents.md has an opencode section

- **WHEN** the file is read at HEAD
- **THEN** there is a heading exactly named `opencode` (lowercase, no prefix)
- **AND** the section has subsections "Install", "Configure", "Verify", "Troubleshooting" in that order
- **AND** the section's first paragraph names `~/.config/opencode/plugins/` and `~/.config/rembric/bin/` as the two install destinations

#### Scenario: README lists opencode

- **WHEN** `README.md` is read at HEAD
- **THEN** every list of supported clients includes `opencode` as a peer of Claude Code, Codex CLI, and Hermes Agent

### Requirement: Session.idle handler (periodic flush)

The `event` dispatcher's `"session.idle"` branch is the PRIMARY mechanism that delivers the transcript to the server during the session lifetime, and it is also this client's end-of-turn moment. It fires once per agent turn (after the assistant response completes and before the next user prompt). The branch SHALL:

1. Return immediately if `input.sessionID` is in `subAgentSessions`.
2. Schedule a debounced flush for `input.sessionID` with a 500ms quiet period. If a prior debounce-timer is pending for the same session id, cancel it and schedule afresh. Implementation note: use `setTimeout` / `clearTimeout` plus a `Map<string, ReturnType<typeof setTimeout>>` to track per-session pending timers.
3. The debounced flush callback SHALL call `flushSessionSummary(sessionId)` (the shared helper used by `server.instance.disposed`), which POSTs `/api/<slug>/sessions/<id>/summary` with body `{summary, title?, final:false}`.
4. **Issue the per-turn report** (`session-nudges`) through the shared core, reading and clearing the per-session tool-observation flag, and cache the returned lines for the next `chat.message`. The report SHALL NOT be folded into the debounce: the debounce exists to coalesce a burst of idle events into one transcript POST, whereas the report must correspond one-to-one with turns, and a coalesced report would under-count work and lose a notice.

Rationale for the flush: opencode's `server.instance.disposed` is fire-and-forget at the runtime level (verified by spike — see design.md::Decision 4 resolved). Async POSTs from that handler don't land. The per-turn flush keeps the server's summary current at all times so that even if `server.instance.disposed` fails to deliver, the row is at-most-one-turn behind reality. **That flush is retained deliberately and SHALL NOT be removed as part of moving the nudge to the server**: this client's in-memory accumulator holds the only copy of its transcript, and the convergence guarantee in `plugin-session-protocol` rests on it.

The debounce SHALL NOT exceed 2 seconds (don't accumulate too much state in-flight) and SHALL NOT be below 200ms (don't POST on every keystroke during streaming).

#### Scenario: session.idle fires periodic flush per turn

- **GIVEN** a session "s1" with three user prompts each followed by an assistant response, accumulator contains user+assistant turns
- **WHEN** the `event` dispatcher receives `session.idle` after the third assistant turn
- **THEN** within 500ms a POST to `/api/<slug>/sessions/s1/summary` is issued
- **AND** the body's `summary` contains all six turns

#### Scenario: Rapid-fire session.idle events debounce the flush but not the report

- **GIVEN** the `event` dispatcher receives `session.idle` three times within 100ms for the same session id
- **WHEN** the debounce timer expires
- **THEN** exactly ONE `/summary` POST is issued (the prior timers were cancelled)
- **AND** the report path SHALL be governed by turn boundaries rather than by that timer, so a burst within one turn SHALL NOT be reported three times

### Requirement: Server.instance.disposed flush handler (best-effort)

The `event` dispatcher's `"server.instance.disposed"` branch SHALL iterate the closure-scoped `knownSessions` Set and, for each session id, issue a fire-and-forget `fetch(...)` request to `/api/<slug>/sessions/<id>/summary` with body `{summary, title?, final:false}`. The handler MUST NOT `await` the fetch — opencode does not await async handlers at dispose time (verified by spike, design.md::Decision 4 resolved). Awaiting would block opencode's exit AND would still get the subprocess killed before completion. The fire-and-forget call gives the kernel a chance to flush the TCP packet before the subprocess is killed; success is opportunistic.

The body shape is identical to the `session.idle` flush:

- `summary` is the joined transcript: each entry rendered as `<role>: <text>`, separated by `\n\n`, oldest first, truncated from the head if the result exceeds 19500 characters.
- `title` is derived from the first `{role:'user'}` entry's text, truncated to 100 characters. If no user entry exists yet, `title` is OMITTED.
- `final` is always `false`.

The handler SHALL skip sessions whose id is in `subAgentSessions`. The handler SHALL emit ONE stderr diagnostic line per session id of the form `[rembric] dispose-flush sessionId=<id> (fire-and-forget)` to make the attempt visible in opencode's debug logs. Errors are silent — the fetch returns a promise we ignore.

The handler is documented as expected-to-often-fail. The user-facing impact is at-most-one-turn data loss in the worst case (the gap between the last `session.idle` flush and the close). The PRIMARY guarantee for non-cooperating-agent summary convergence comes from `session.idle`; `server.instance.disposed` is the cherry-on-top.

The plugin SHALL declare a `// dispose-spike-result: fire-and-forget` comment in the first 10 lines of `plugin.ts`, recording the spike outcome (locked because the spike result is empirically determined and unlikely to change without a major opencode version bump).

#### Scenario: Disposed event POSTs summary for every known session

- **GIVEN** `knownSessions` contains `["s1", "s2"]` and `sessionMessages` has both with non-empty entries
- **WHEN** the `event` dispatcher receives `event.type === "server.instance.disposed"`
- **THEN** the handler POSTs to `/api/<slug>/sessions/s1/summary` AND `/api/<slug>/sessions/s2/summary`
- **AND** each body has `final: false`
- **AND** each body's `summary` is the role-prefixed transcript truncated to ≤ 19500 chars
- **AND** the bodies omit `title` for sessions whose accumulator has no user entry, OR include `title` as the first-user-text truncated to 100 chars when present

#### Scenario: Disposed event is best-effort

- **GIVEN** the Rembric server is unreachable (5xx, ECONNREFUSED, timeout)
- **WHEN** the dispose handler runs
- **THEN** one stderr diagnostic per failed session is written
- **AND** the handler returns normally without throwing
- **AND** opencode's shutdown is not blocked

#### Scenario: Sub-agent sessions are skipped at dispose time

- **GIVEN** `subAgentSessions` contains `"sub-1"` AND `knownSessions` does NOT contain `"sub-1"` (the v1 filter prevents sub-agents from being added)
- **WHEN** the dispose handler runs
- **THEN** no POST is issued for `"sub-1"`

#### Scenario: Existing model summary (final:true) is preserved

- **GIVEN** session `"s1"` already has `summary_final=true` (the agent previously called `memory.session_summary({final:true})`)
- **WHEN** the dispose handler POSTs `/summary` with `final:false`
- **THEN** the server applies the precedence rule and does NOT overwrite the existing summary
- **AND** the dispose-flush is effectively a no-op for that session

### Requirement: Chat.message handler accumulates user transcript

The `"chat.message"` handler SHALL:

1. Return immediately if `input.sessionID` is in `subAgentSessions`.
2. Call `await ensureSession(input.sessionID)` — idempotent (a no-op if the session is already known) — so a session opencode resumes into without re-emitting `session.created` (e.g. after a client restart) still gets registered before any accumulation or flush happens for it.
3. Extract text from `output.parts` filtering `part.type === "text"`, joining with newlines, and trimming. If empty, fall back to `output.message.summary.title + "\n" + output.message.summary.body` if available.
4. If the resulting text is empty, return without mutating state.
5. Otherwise append `{role: 'user', text: <stripped+truncated>}` to `sessionMessages.get(input.sessionID)` (creating the array if it does not exist).
6. The handler SHALL pass the text through a `stripPrivateTags` helper that replaces `<private>...</private>` blocks (case-insensitive, multiline) with `[REDACTED]`. The handler SHALL truncate each entry to 2000 characters with a `"..."` suffix if longer.
7. The accumulator MUST cap each session's array at 200 entries. If the array reaches the cap, the oldest entry is shifted out (FIFO) before the new entry is appended. This protects against unbounded memory growth in long sessions.
8. After the above, for a non-subagent session, the handler SHALL call `flushSessionSummary(input.sessionID)` **without awaiting it** (`void flushSessionSummary(...)`) — a fire-and-forget POST of the accumulated transcript to `/sessions/:id/summary`, on every call, with no throttle and no counter. The handler itself SHALL NOT await, block on, or otherwise delay its own return on this call.

The handler SHALL await `ensureSession` (step 2) but SHALL NOT `await` any HTTP request beyond that as part of its own control flow — the fire-and-forget flush in step 8 is the sole additional POST this handler triggers, and it must never delay the handler's return. `ensureSession` itself resolves quickly (it either no-ops on an already-known session or fires a single registration POST that the handler does wait on, matching the existing behavior of `session.created` and `experimental.session.compacting`, which already await it). (Previously this handler made no HTTP request at all and relied solely on the `server.instance.disposed` flush; that periodic accumulation-only behavior is superseded by step 8 without removing the dispose-time flush, which remains a last-chance mechanism for whatever accumulated since the last `chat.message`.)

#### Scenario: User text accumulates

- **WHEN** `chat.message` fires three times with sessionID `"s1"` and user text `"hello"`, `"fix the bug"`, `"thanks"`
- **THEN** `sessionMessages.get("s1")` is `[{role:'user', text:'hello'}, {role:'user', text:'fix the bug'}, {role:'user', text:'thanks'}]`
- **AND** each call additionally triggers an un-awaited `flushSessionSummary("s1")`

#### Scenario: Private tags are redacted before accumulation

- **WHEN** `chat.message` fires with user text `"Connect to <private>postgresql://u:p@host/db</private> and run a count"`
- **THEN** the appended entry's `text` is `"Connect to [REDACTED] and run a count"`

#### Scenario: Sub-agent prompts are skipped

- **GIVEN** `subAgentSessions` contains `"sub-1"`
- **WHEN** `chat.message` fires with `input.sessionID = "sub-1"`
- **THEN** `sessionMessages` does NOT gain an entry for `"sub-1"`
- **AND** `flushSessionSummary` SHALL NOT be called for `"sub-1"`
- **AND** `ensureSession` SHALL NOT be called for `"sub-1"`

#### Scenario: Accumulator caps at 200 entries

- **GIVEN** `sessionMessages.get("s1").length === 200`
- **WHEN** a 201st `chat.message` fires for `"s1"`
- **THEN** the oldest entry is removed (the array length stays at 200)
- **AND** the newest entry is at the tail

#### Scenario: The per-turn flush never blocks the handler's return

- **WHEN** `chat.message` fires and `flushSessionSummary`'s underlying `fetch` is slow or hangs
- **THEN** the handler SHALL still return promptly (its own promise resolves without waiting on the fetch), because the call is `void`-invoked, not awaited
- **AND** the written `summary`/`title` SHALL have `final` omitted, so the server never marks the session curated from this path

#### Scenario: The per-turn flush does not replace the dispose-time last-chance flush

- **GIVEN** a session with accumulated messages since its last `chat.message`-triggered flush
- **WHEN** the opencode process is killed and `server.instance.disposed` fires
- **THEN** the existing best-effort dispose flush SHALL still attempt to send whatever accumulated since the last per-turn flush, unchanged from its current behavior

#### Scenario: A resumed session with no prior session.created is registered before its first flush

- **GIVEN** `knownSessions` does NOT contain `"resumed-1"` (opencode did not re-emit `session.created` for it after a restart) and `subAgentSessions` does NOT contain it either
- **WHEN** `chat.message` fires for `input.sessionID = "resumed-1"` with non-empty user text
- **THEN** `ensureSession("resumed-1")` SHALL run BEFORE the text is appended to `sessionMessages`, registering the session via `POST /sessions`
- **AND** the subsequent `void flushSessionSummary("resumed-1")` call SHALL find the session in `knownSessions` and actually POST the summary, instead of silently no-opping

### Requirement: Message.updated handler tracks role

The `event` dispatcher's `"message.updated"` branch SHALL NOT extract assistant text from `properties.info` — `@opencode-ai/sdk`'s `Message` type (`UserMessage | AssistantMessage`, the shape of `message.updated`'s `properties.info`) carries NO `parts` field, only metadata (id, role, cost, tokens, timing). Assistant text is delivered exclusively via separate `message.part.updated` events (see the next requirement); `message.updated` exists solely to learn which message ids are assistant-authored.

The branch SHALL:

1. Return immediately if `properties.info.sessionID` is empty or in `subAgentSessions`.
2. Return immediately if `properties.info.id` or `properties.info.role` is missing.
3. Record `messageRoles.set(info.id, info.role)` in a closure-scoped `Map<string, string>`. This is the ONLY side effect — the branch SHALL NOT touch `sessionMessages` and SHALL NOT read or extract any `parts`-shaped field from `info`.

#### Scenario: Role is recorded for later part-accumulation lookup

- **WHEN** the `event` dispatcher receives `message.updated` with `info.id="m1"`, `info.role="assistant"`, `info.sessionID="s1"`
- **THEN** `messageRoles.get("m1")` is `"assistant"`
- **AND** `sessionMessages` is unmodified

### Requirement: Message.part.updated handler accumulates assistant transcript

The `event` dispatcher's `"message.part.updated"` branch SHALL:

1. **Record that the turn used a tool when `properties.part.type` is exactly `"tool"`**, setting a per-session boolean the `session.idle` report reads and clears (`session-nudges`). This SHALL happen before the early return in step 2, because that return is precisely the branch a tool part takes.
2. Return immediately if `properties.part.type !== "text"`.
3. Return immediately if `properties.part.sessionID`, `properties.part.messageID`, or `properties.part.id` is empty.
4. Return immediately if `properties.part.sessionID` is in `subAgentSessions`, or is not in `knownSessions`.
5. Return immediately if `messageRoles.get(properties.part.messageID) !== "assistant"`. This is a no-op for user-authored parts (captured instead by `chat.message`) and for parts seen before their owning message's `message.updated` event — an accepted at-most-one-part-dropped race, matching the "opt out until known" pattern used elsewhere in this plugin.
6. Record `properties.part.text` in a closure-scoped `Map<string, Map<string, string>>` (`assistantParts`), keyed first by `messageID` then by `part.id` (a message can carry multiple text parts).
7. Join all part texts for that `messageID` (insertion order) with `\n`, apply the same `stripPrivateTags` and truncate-to-2000 transforms as `chat.message`, and upsert `{role:'assistant', text, id:<messageID>}` into `sessionMessages` (replace if an entry with that id exists, else append; FIFO-evict past the 200-entry cap).

The branch MUST be idempotent under streaming updates: opencode fires `message.part.updated` many times per assistant turn (token-by-token, and potentially once per distinct part). The id-keyed replacement in step 7 ensures only one final-state entry per assistant message in the accumulator. The tool flag in step 1 is idempotent by construction — it is set, never counted.

**The concrete part type SHALL be pinned to the SDK's `"tool"` literal, not to "not `text`"**, because `plugin.ts` types `part.type` as an open `string` and the union carries ten other members that are not tool use. If the host emits no `tool` part for a tool invocation, this client falls under the fail-open rule in `session-nudges` and reports `true`, and this step SHALL be rewritten to say so rather than left describing a signal that does not arrive.

`messageRoles`, `assistantParts`, the per-session tool flag and the per-session line cache MUST be cleared when that session's `session.deleted` event fires (alongside the existing `sessionMessages`/`pendingFlush` cleanup), to avoid unbounded growth across a long-running opencode server process. The `userTurnCounts` map named in the previous version of this cleanup no longer exists.

#### Scenario: Assistant text is appended on first sight, replaced on subsequent updates

- **GIVEN** `sessionMessages.get("s1")` is `[]` and `messageRoles.get("m1") === "assistant"`
- **WHEN** the `event` dispatcher receives `message.part.updated` with `part.messageID="m1"`, `part.id="p1"`, `part.sessionID="s1"`, text `"Hello,"`
- **THEN** `sessionMessages.get("s1")` is `[{role:'assistant', text:'Hello,', id:'m1'}]`
- **WHEN** the dispatcher receives `message.part.updated` again with the SAME `part.id="p1"` and longer text `"Hello, working on it."`
- **THEN** the entry's text is replaced; the array length stays at 1; the entry's position is unchanged
- **WHEN** the dispatcher receives `message.part.updated` with `part.messageID="m2"`, `part.id="p2"`, text `"Done."` (and `messageRoles.get("m2") === "assistant"`)
- **THEN** `sessionMessages.get("s1")` is `[{role:'assistant', text:'Hello, working on it.', id:'m1'}, {role:'assistant', text:'Done.', id:'m2'}]`

#### Scenario: A tool part sets the tool flag and is otherwise ignored

- **GIVEN** a session "s1" in `knownSessions`
- **WHEN** the dispatcher receives `message.part.updated` with `part.sessionID="s1"` and `part.type="tool"`
- **THEN** the per-session tool flag for "s1" SHALL be set
- **AND** `sessionMessages.get("s1")` SHALL be unchanged
- **WHEN** the dispatcher instead receives a part whose `type` is `"reasoning"`, `"snapshot"` or `"step-start"`
- **THEN** the flag SHALL NOT be set

#### Scenario: Non-assistant roles and unregistered sessions are ignored

- **WHEN** the `event` dispatcher receives `message.part.updated` for a `part.messageID` whose `messageRoles` entry is `"user"`, `"system"`, `"tool"`, or absent
- **THEN** the branch returns without mutating `sessionMessages`
- **WHEN** the `event` dispatcher receives `message.part.updated` for a `part.sessionID` not in `knownSessions`
- **THEN** the branch returns without mutating `sessionMessages`

### Requirement: Dispose spike result MUST be recorded

The plugin's source file (`apps/plugin/.opencode-plugin/plugin.ts`) MUST declare the comment line `// dispose-spike-result: fire-and-forget` within the first 10 lines, recording the outcome of the pre-implementation runtime spike. Outcome: opencode kills the subprocess before async handlers complete; awaited fetches do not land (full evidence in design.md::Decision 4 resolved). An invariant test (`apps/server/src/test/invariants.test.ts`) MUST fail the build if the line is absent. The plugin SHALL NOT contain any other `// dispose-spike-result:` line.

#### Scenario: Spike-result comment is recorded

- **WHEN** `apps/plugin/.opencode-plugin/plugin.ts` is read at HEAD
- **THEN** the first 10 lines contain `// dispose-spike-result: fire-and-forget`
- **AND** the `server.instance.disposed` handler does NOT `await` the fetch call

### Requirement: Install script auto-configures opencode.json

`apps/plugin/.opencode-plugin/install.sh` SHALL, in addition to copying the plugin/bridge/dotenv files, manage the `~/.config/opencode/opencode.json` file with conservative semantics so the user does not need to copy-paste an MCP block manually.

Behaviour:

1. If `~/.config/opencode/opencode.json` does NOT exist: the script SHALL create it with a single `mcp.rembric` block. The block SHALL use `{env:VAR}` substitution syntax for credentials (verified to work in opencode 1.15.x — opencode interpolates these from the parent shell at MCP subprocess spawn time). The user only needs to `export REMBRIC_SERVER_URL=...` and `export REMBRIC_API_TOKEN=...` in their shell rc.
2. If `~/.config/opencode/opencode.json` EXISTS and parses as JSON AND has NO `mcp.rembric` key: the script SHALL warn the user and print the snippet to paste manually (do NOT auto-merge — JSONC support and other-MCP-server coexistence make `jq` merging risky).
3. If `~/.config/opencode/opencode.json` EXISTS and ALREADY has an `mcp.rembric` key: the script SHALL leave it untouched and print a one-line status confirming detection.

The written block SHALL be exactly:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "rembric": {
      "type": "local",
      "command": ["node", "<absolute installed bridge path>"],
      "environment": {
        "REMBRIC_SERVER_URL": "{env:REMBRIC_SERVER_URL}",
        "REMBRIC_API_TOKEN": "{env:REMBRIC_API_TOKEN}"
      },
      "enabled": true
    }
  }
}
```

The script's success banner SHALL instruct the user to `export REMBRIC_SERVER_URL=...` and `export REMBRIC_API_TOKEN=...` in their shell rc and restart opencode. The token SHALL be shown as obtained from `/dashboard/tokens` (plaintext shown once).

The plain-text MCP snippet is no longer printed for the auto-write path. It is still printed for case (2) (existing file without rembric block) so the user has the block to merge manually.

#### Scenario: Fresh install writes opencode.json with env-substitution

- **GIVEN** no `~/.config/opencode/opencode.json` exists
- **WHEN** `install.sh` runs
- **THEN** `~/.config/opencode/opencode.json` is created with exactly the documented block
- **AND** the `environment` block uses `"{env:REMBRIC_SERVER_URL}"` and `"{env:REMBRIC_API_TOKEN}"` literally
- **AND** the success banner instructs the user to `export REMBRIC_SERVER_URL` and `export REMBRIC_API_TOKEN`

#### Scenario: Existing opencode.json without rembric block — print snippet

- **GIVEN** `~/.config/opencode/opencode.json` exists with `{"mcp":{"other-server":{...}}}` but no `mcp.rembric`
- **WHEN** `install.sh` runs
- **THEN** `~/.config/opencode/opencode.json` is left UNCHANGED
- **AND** the script prints the MCP block for the user to merge manually
- **AND** the script exits 0 with a warning

#### Scenario: Existing opencode.json with rembric block — leave alone

- **GIVEN** `~/.config/opencode/opencode.json` already contains an `mcp.rembric` block
- **WHEN** `install.sh` runs
- **THEN** `~/.config/opencode/opencode.json` is left UNCHANGED
- **AND** the script prints a one-line confirmation (e.g., `[rembric] mcp.rembric already configured in opencode.json — skipped`)

### Requirement: Session.compacted handler flushes the accumulator at the compaction milestone

The `event` dispatcher SHALL handle `event.type === "session.compacted"` as the third opencode event (alongside `session.idle` and `server.instance.disposed`) that triggers a summary flush. Its purpose is to persist the rolling transcript at the moment opencode signals a compaction has completed.

The handler SHALL:

1. Extract the session id from `event.properties.sessionID` (or `event.properties.info.id` as a fallback, mirroring the existing `session.created` extraction pattern). If the id is empty, the handler SHALL return.
2. Skip if the id is in `subAgentSessions`. Skip if the id is NOT in `knownSessions` (we only flush sessions whose row was already registered).
3. Emit one stderr diagnostic of the form `[rembric] session.compacted sessionId=<id>`.
4. Await `flushSessionSummary(sessionId)` — the same helper used by `session.idle`. This builds the body via `buildSummaryBody(sessionId)` (joining the accumulator entries as `<role>: <text>` lines, truncating from the head at 19500 chars) and POSTs to `/api/<slug>/sessions/<id>/summary` with `final:false`.

The handler SHALL NOT reset, clear, or otherwise mutate `sessionMessages` for the affected session id. opencode's `session.compacted` is a notification event, not a content-delivery event — the in-memory accumulator persists across the compaction, so subsequent `session.idle` events MAY continue to flush a transcript that includes both pre-compact and post-compact turns.

opencode's `session.compacted` event does NOT deliver the model-authored compaction summary payload. The handler SHALL NOT attempt to extract one from the event. The PRIMARY signal we persist at this milestone is the in-memory accumulator's rolling transcript — the same content that `session.idle` would flush, just triggered by the explicit compaction event for milestone clarity.

#### Scenario: session.compacted flushes for a known top-level session

- **GIVEN** `knownSessions` contains `"s1"`, `sessionMessages.get("s1")` contains turns
- **WHEN** the dispatcher receives an event with `type === "session.compacted"` and a sessionID resolving to `"s1"`
- **THEN** the handler SHALL emit one stderr diagnostic naming the id
- **AND** SHALL await `flushSessionSummary("s1")` exactly once
- **AND** SHALL NOT mutate `sessionMessages.get("s1")`

#### Scenario: session.compacted is a no-op for sub-agent sessions

- **GIVEN** `subAgentSessions` contains `"sub-1"`
- **WHEN** the dispatcher receives a session.compacted event for `"sub-1"`
- **THEN** the handler SHALL NOT call `flushSessionSummary`
- **AND** SHALL NOT emit the standard diagnostic (the sub-agent skip is silent, matching the existing pattern for sub-agent filtering in other handlers)

#### Scenario: session.compacted is a no-op for unknown sessions

- **GIVEN** `knownSessions` does NOT contain `"s99"`
- **WHEN** the dispatcher receives a session.compacted event for `"s99"`
- **THEN** the handler SHALL NOT call `flushSessionSummary` (we only flush sessions whose row was previously registered)

### Requirement: The opencode installer MUST verify its config detection and import rewrite

The opencode plugin installer SHALL detect an existing Rembric MCP configuration by locating the `rembric` key within the `mcp` object of `opencode.json` (not by matching the substring `"rembric"` anywhere in the file). After rewriting the dev-time relative imports of shared modules to their installed absolute paths, the installer SHALL assert that **each** rewritten import is present in the installed plugin file, and SHALL abort with a clear error when any assertion fails, instead of installing a plugin that cannot load.

The assertion SHALL be per-import rather than a single check, and the reason is a measured failure shape rather than caution: with a single-destination `grep -qF` guard and two rewritten imports, the installer exits 0 having written a plugin that cannot load, and the installer test suite stays green because nothing in it ever loads the installed plugin. The per-import assertion SHALL be covered by a test that fails when any one of the assertions is removed.

#### Scenario: Unrelated `"rembric"` string elsewhere in opencode.json

- **WHEN** `opencode.json` contains the string `"rembric"` outside the `mcp` object (e.g. an MCP server named `rembric-foo` or an unrelated key) and no `mcp.rembric` entry
- **THEN** the installer SHALL treat Rembric as NOT configured and print the config snippet as on a fresh install

#### Scenario: Import rewrite no-ops due to source drift

- **WHEN** any `sed` rewrite of a shared-module import produces a file that does not reference the corresponding installed path
- **THEN** the installer SHALL exit non-zero with an error naming the failed rewrite, and SHALL NOT leave the broken plugin file installed

#### Scenario: Dropping one assertion reds a test

- **GIVEN** the installer's rewrite verification is weakened to check only one of the rewritten imports
- **WHEN** the installer test suite runs
- **THEN** at least one test SHALL fail naming the unverified rewrite

### Requirement: The opencode plugin SHALL report each turn on `session.idle` and print the server's lines on `chat.message`

`apps/plugin/.opencode-plugin/plugin.ts` SHALL participate in the report-and-print contract (`session-nudges`) through the two events it already registers, adding no new event registration.

**Reporting, on `session.idle`.** That branch already fires once per agent turn, after the assistant response completes and before the next user prompt, which is exactly the end-of-turn moment the contract names. It SHALL, in addition to the debounced transcript flush it already performs, call the shared core's turn-report helper for the session, and the core SHALL read its own tool-observation latch and cache the returned lines. Subagent sessions SHALL NOT be reported.

**Observing tool use.** The `message.part.updated` branch SHALL arm the shared core's tool-observation latch when it sees a part whose `type` is exactly `"tool"` — that branch already inspects `part.type` and returns early for everything that is not `text`, so the observation costs one comparison on a path that already runs. The latch SHALL be disarmed by the core at the turn boundary the `chat.message` handler already marks, and read and cleared by the report on `session.idle`. **This client SHALL hold no per-session flag of its own**: the predicate above is what differs between hosts, and the latch is not. **The concrete type is pinned, and it is NOT "anything that is not `text`":** the installed SDK's `Part` union enumerates `text`, `subtask`, `reasoning`, `file`, `tool`, `step-start`, `step-finish`, `snapshot`, `patch`, `agent`, `retry` and `compaction`, so a not-`text` test reports tool use for a turn that only thought out loud or emitted a step marker. If a future host emits no `tool` part for a tool invocation, this client falls under the fail-open rule in `session-nudges` and reports `true`, and this requirement SHALL be amended to say so.

**Printing, on `chat.message`.** The handler SHALL push the cached lines — the sessionId line first, then the server's lines verbatim — as separate `output.parts` text parts, each through the existing `nudgePart` helper, since opencode validates every pushed part against its real `TextPart` schema and a bare `{ type: 'text', text }` takes down the turn. Reading the cache SHALL clear it. The recall nudge and the session opening are pushed by the same handler from the shared fixtures and are independent of the notice: any combination MAY fire on the same turn and none replaces another.

**The handler SHALL compose no reminder text of its own.** The unprefixed `…Core` fixture variants remain the source for the client-composed lines; the notice arrives already prefixed from the server.

Subagent sessions SHALL neither be reported nor printed to (the handler's existing subagent guard covers both). The per-session cache and the latch SHALL be evicted by the core's `forgetSession`, which the existing `session.deleted` cleanup already calls — this handler SHALL NOT carry a second eviction beside it.

**Exactly ONE per-session container stays local to this handler: the once-per-turn report gate**, which `session-nudges` requires of every client ("Each client's report SHALL be issued at most once per turn") and which only this host needs, because only this host can re-enter its end-of-turn event within one turn. It SHALL NOT be moved into the shared core: the core is shared with Pi, whose `agent_settled` carries no such gate, so a core-held gate would either change Pi's behaviour or become a per-client opt-in — a second mechanism where the point of the core is to have one. Because its eviction beside `core.forgetSession` is the exception this requirement otherwise forbids, that eviction SHALL be covered by a test that fails when it is removed, so it cannot be dropped as dead code by a later reader applying the rule above.

#### Scenario: One report per turn, from `session.idle`

- **GIVEN** a non-subagent opencode session driven through three user prompts and three assistant responses
- **WHEN** the three `session.idle` events have fired
- **THEN** exactly three turn reports SHALL have been issued
- **AND** no report SHALL have been issued from `chat.message`

#### Scenario: The local turn gate is evicted with the session it belongs to

- **GIVEN** an opencode session whose `session.idle` has already reported the current turn
- **WHEN** `session.deleted` fires and the same id is created again
- **THEN** the next `session.idle` SHALL issue a report
- **AND** the control SHALL pass in the same run: the first `session.idle` SHALL have issued one, so the second is measured against a gate that really closed

#### Scenario: A tool part is observed and reported

- **GIVEN** a turn during which `message.part.updated` fired with a part whose `type` is `"tool"`
- **WHEN** `session.idle` fires
- **THEN** the report SHALL carry `usedTools: true`
- **AND** the control SHALL pass in the same run: a turn whose only non-`text` parts are `reasoning`, `snapshot` or the step markers SHALL report `usedTools: false`

#### Scenario: The flag survives the whole turn, not just the last part

- **GIVEN** a turn whose part sequence is a tool part followed by several `text` parts of the assistant's closing answer
- **WHEN** `session.idle` fires
- **THEN** the report SHALL carry `usedTools: true`
- **AND** the latch SHALL have been armed once and read once, rather than recomputed from the most recent part

#### Scenario: A tool part arriving after the report belongs to the next turn's start, not to it

- **GIVEN** a session whose `session.idle` report for turn one has already been issued
- **WHEN** a `tool` part arrives before the next `chat.message`, and that turn then ends with no tool of its own
- **THEN** the second report SHALL carry `usedTools: false`
- **AND** the control SHALL pass in the same run: turn one's report SHALL have carried `usedTools: true`

#### Scenario: The server's lines are pushed verbatim, as valid parts

- **GIVEN** a cached notice from the previous turn's report
- **WHEN** `chat.message` next fires for that session
- **THEN** each line SHALL be pushed as its own `output.parts` entry built by `nudgePart`, carrying `id`, `sessionID` and `messageID`
- **AND** the text of each SHALL be byte-identical to the corresponding line in the report's response
- **AND** the cache SHALL be cleared, so the next `chat.message` pushes neither

#### Scenario: The plugin declares no reminder text and no cadence

- **WHEN** `apps/plugin/.opencode-plugin/plugin.ts` is read at HEAD
- **THEN** it SHALL contain no `SAVE_NUDGE_EVERY`, no `SUMMARY_NUDGE_EVERY`, no turn-count map and no modulo
- **AND** it SHALL declare no string directing the model to save or to summarise

#### Scenario: Subagent sessions are neither reported nor printed to

- **WHEN** the message or idle event belongs to a sub-agent session
- **THEN** no report SHALL be issued and no line SHALL be pushed (early return, as today)
