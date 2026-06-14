# opencode-plugin Specification

## Purpose

TBD - created by archiving change add-opencode-plugin. Update Purpose after archive.

## Requirements

### Requirement: Plugin source location

The plugin SHALL live in this monorepo at `apps/plugin/.opencode-plugin/`, sibling to `apps/plugin/.claude-plugin/`, `apps/plugin/.codex-plugin/`, and `apps/plugin/.hermes-plugin/`. The directory SHALL contain exactly four files at the top level: `plugin.ts`, `install.sh`, `uninstall.sh`, `README.md`. A co-located test file `plugin.test.ts` MAY exist alongside `plugin.ts` for vitest-based unit testing; the test file is NOT distributed to users.

The plugin SHALL NOT carry its own copy of the dotenv parser, slug regex, or `readRembricSlug` function. Those helpers live in the shared `apps/plugin/bin/rembric-dotenv.mjs` module (single source of truth, also consumed by `apps/plugin/bin/rembric-bridge.mjs`). `plugin.ts` imports from that module via the relative path `../bin/rembric-dotenv.mjs` at source time; `install.sh` rewrites the path to the absolute installed location before copying.

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

### Requirement: Shared dotenv lib SHALL be the single source of truth for slug parsing

The repository SHALL contain `apps/plugin/bin/rembric-dotenv.mjs` exporting exactly: `parseDotenv(content: string)`, `readRembricSlug(directory: string)`, and `SLUG_RE`. This module SHALL be the only place where the slug regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` and the dotenv parser live in JS/TS form across the entire repository.

`apps/plugin/bin/rembric-bridge.mjs` SHALL import `parseDotenv` and `SLUG_RE` from `./rembric-dotenv.mjs`. `apps/plugin/.opencode-plugin/plugin.ts` SHALL import `readRembricSlug` from `../bin/rembric-dotenv.mjs`. Neither file SHALL define its own copy of these helpers.

Bash (`apps/plugin/scripts/_api.sh::rembric_parse_dotenv` and `::rembric_read_project_slug`) and Python (`apps/plugin/.hermes-plugin/__init__.py::_SLUG_RE`) clients keep their own implementations because cross-language wrapping a 20-line parser costs more than the duplication. Those implementations MUST agree on the regex.

An invariant test in `apps/server/src/test/invariants.test.ts` SHALL fail the build if either `plugin.ts` or `rembric-bridge.mjs` declares its own `parseDotenv` function or `SLUG_RE` constant. The invariant test SHALL reference the canonical path `apps/plugin/bin/rembric-dotenv.mjs` in its assertions.

#### Scenario: Shared dotenv lib exists and exports the canonical helpers

- **WHEN** the repository is at HEAD
- **THEN** `apps/plugin/bin/rembric-dotenv.mjs` exists
- **AND** it exports `parseDotenv`, `readRembricSlug`, and `SLUG_RE` as named exports
- **AND** `SLUG_RE.source` equals `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`

#### Scenario: Bridge and opencode plugin both import from the shared lib

- **WHEN** the repository is at HEAD
- **THEN** `apps/plugin/bin/rembric-bridge.mjs` contains an import statement referencing `./rembric-dotenv.mjs`
- **AND** `apps/plugin/.opencode-plugin/plugin.ts` contains an import statement referencing `../bin/rembric-dotenv.mjs`
- **AND** neither file contains a local `function parseDotenv` or `SLUG_RE = /`

#### Scenario: Invariant test catches drift

- **GIVEN** a future change introduces a local `function parseDotenv` inside either `plugin.ts` or `rembric-bridge.mjs`
- **WHEN** `pnpm vitest run apps/server/src/test/invariants.test.ts` runs
- **THEN** the test FAILS with a message naming the offending file

### Requirement: Plugin module exports a Plugin function

`apps/plugin/.opencode-plugin/plugin.ts` SHALL export a named const `RembricPlugin` typed as `Plugin` (from `@opencode-ai/plugin`). The export SHALL be an async function that receives the opencode plugin context (`{ project, client, $, directory, worktree }`) and returns an object whose properties are the event handler subscriptions.

The plugin module SHALL be importable in a Node/Bun environment that has `@opencode-ai/plugin` available as a peer dependency. The repository SHALL NOT add `@opencode-ai/plugin` to its own `dependencies` or `devDependencies` — it is consumed only at the user's runtime when opencode loads the plugin file.

A version comment of the form `// @rembric-plugin-version <semver>` SHALL appear in the first five lines of `plugin.ts`, wrapped on the line above and below by `// x-release-please-start-version` and `// x-release-please-end` (release-please's standard annotation for updating arbitrary text in non-package files). opencode has no manifest to declare a version; the comment is the only place to record it for diagnostics, and the `x-release-please-*` wrappers are what let release-please's `opencode-plugin` component find and update the version via the `extra-files` generic updater (NOT in lock-step with other plugin components — opencode versions independently).

#### Scenario: Plugin file declares its version

- **WHEN** the file is read at HEAD
- **THEN** one of the first five lines matches `^// @rembric-plugin-version \d+\.\d+\.\d+$`
- **AND** the captured version equals the most recent `opencode-plugin-vX.Y.Z` git tag

#### Scenario: Plugin module loads under Bun

- **WHEN** Bun resolves `~/.config/opencode/plugins/rembric.ts` at opencode startup with `@opencode-ai/plugin` available
- **THEN** the import succeeds without error
- **AND** the exported `RembricPlugin` is an async function
- **AND** calling `RembricPlugin(ctx)` returns a Promise whose resolved value is a plain object with event-handler properties

#### Scenario: Version is managed by the opencode-plugin release-please component

- **WHEN** a commit modifies only files under `apps/plugin/.opencode-plugin/`
- **THEN** release-please's `opencode-plugin` component SHALL stage a version bump for the `// @rembric-plugin-version` comment in `plugin.ts`
- **AND** the bump SHALL be independent of `claude-code-plugin`, `codex-plugin`, `hermes-plugin`, and `server`
- **AND** a `opencode-plugin-vX.Y.Z` git tag SHALL be created when the release-please PR is merged

### Requirement: MCP transport reuses the existing stdio bridge

The opencode plugin SHALL reuse `apps/plugin/bin/rembric-bridge.mjs` verbatim — the same file consumed by Claude Code and Codex CLI. The bridge SHALL NOT be forked, copied with modifications, or replaced by an opencode-specific variant.

The MCP server entry in the user's `opencode.json` SHALL be:

```json
{
  "mcp": {
    "rembric": {
      "type": "local",
      "command": ["node", "<HOME>/.config/rembric/bin/rembric-bridge.mjs"],
      "environment": {
        "REMBRIC_SERVER_URL": "<URL>",
        "REMBRIC_API_TOKEN": "<TOKEN>"
      },
      "enabled": true
    }
  }
}
```

where `<HOME>` is the literal string from `$HOME` at install time. The install script SHALL substitute `<HOME>` with the resolved absolute path before printing the snippet, but SHALL leave `<URL>` and `<TOKEN>` as placeholders (or as `{env:REMBRIC_*}` substitutions per the install.sh auto-config branch) for the user.

The install script SHALL fetch the bridge from `https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/bin/rembric-bridge.mjs` (and the companion `rembric-dotenv.mjs` from the same `apps/plugin/bin/` prefix) when running against the public repo. Local-dev iteration via `PLUGIN_SRC` + `BIN_SRC` env vars SHALL continue to work, with the dev paths now pointing at `apps/plugin/.opencode-plugin/` and `apps/plugin/bin/` respectively.

The plugin SHALL NOT register its own MCP server programmatically and SHALL NOT use `type: "remote"`.

#### Scenario: Bridge file is reused without divergence

- **WHEN** the repository is at HEAD
- **THEN** `apps/plugin/.opencode-plugin/` contains no `*.mjs` or `*-bridge.*` file
- **AND** the install script copies `apps/plugin/bin/rembric-bridge.mjs` (not a sibling copy) to the user's `~/.config/rembric/bin/`

#### Scenario: MCP snippet uses type: local with the shared bridge path

- **WHEN** the install script runs and prints the MCP snippet
- **THEN** the printed JSON has `mcp.rembric.type = "local"`
- **AND** `mcp.rembric.command` is `["node", "<expanded $HOME>/.config/rembric/bin/rembric-bridge.mjs"]`
- **AND** `mcp.rembric.environment` declares exactly `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` as placeholder values for the user to edit

#### Scenario: Default install URLs point at apps/plugin

- **WHEN** a user runs `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.opencode-plugin/install.sh | sh`
- **THEN** the script SHALL fetch `plugin.ts` from `.../apps/plugin/.opencode-plugin/plugin.ts`
- **AND** the script SHALL fetch `rembric-bridge.mjs` from `.../apps/plugin/bin/rembric-bridge.mjs`
- **AND** the script SHALL fetch `rembric-dotenv.mjs` from `.../apps/plugin/bin/rembric-dotenv.mjs`
- **AND** none of the URLs SHALL contain the legacy `/plugin/` path

#### Scenario: Legacy install URL returns 404

- **WHEN** a user runs `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.opencode-plugin/install.sh | sh`
- **THEN** `curl -fsSL` SHALL fail with a 404 from `raw.githubusercontent.com` and exit non-zero — no shim file is kept under `plugin/`
- **AND** no files SHALL be installed under `~/.config/opencode/` or `~/.config/rembric/bin/`
- **AND** the corrected install command SHALL be discoverable in `README.md`, `docs/agents.md`, `apps/plugin/.opencode-plugin/README.md`, and the first post-restructure `opencode-plugin-vX.Y.Z` release notes

### Requirement: Slug resolution uses the .rembric convention shared across clients

The bridge spawned by opencode SHALL resolve the project slug by reading `<cwd>/.rembric` and parsing `PROJECT_SLUG=<slug>` from dotenv-style lines (mirroring `_api.sh::rembric_read_project_slug` and the existing bridge contract in `claude-code-plugin::MCP bridge contract`).

The plugin's runtime event handlers (that POST directly to `/api/<slug>/sessions/...` over HTTP, bypassing MCP) SHALL call `readRembricSlug(ctx.directory)` from `apps/plugin/bin/rembric-dotenv.mjs` — the same function the bridge uses. This guarantees byte-identical resolution semantics (same dotenv grammar, same regex, same fail-silent miss behaviour) without duplicating the implementation.

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

1. `event: async ({ event }) => ...` — a dispatcher that switches on `event.type` for `"session.created"`, `"session.deleted"`, and `"server.instance.disposed"`. Any other `event.type` values SHALL be silently ignored.
2. `"chat.message": async (input, output) => ...` — appends a `{role:'user', text}` entry to the per-session transcript accumulator (`sessionMessages` Map). The handler SHALL NOT POST any HTTP request.
3. `"message.updated": async (input, output) => ...` — appends or replaces a `{role:'assistant', text}` entry keyed by `output.message.id` in `sessionMessages`. The handler SHALL NOT POST any HTTP request, and SHALL be a no-op for messages whose role is not `'assistant'`.
4. `"session.idle": async (input) => ...` — schedules a debounced summary flush for `input.sessionID`. PRIMARY mechanism for delivering transcript-to-server during the session. See `Session.idle handler (periodic flush)`.
5. `"experimental.session.compacting": async (input, output) => ...` — post-compaction reminder injection.

The plugin SHALL NOT register `"tool.execute.after"`. The corresponding `/api/<slug>/observations/passive` endpoint does not exist on Rembric's HTTP API; the handler has no work to do.

The plugin SHALL NOT register `experimental.chat.system.transform` (no system-prompt injection). The plugin SHALL NOT register `tool.execute.before` (no tool guards). The plugin SHALL NOT register `permission.asked` or `permission.replied`.

If Plan B of the cwd spike applies (see "cwd spike" requirement), the plugin SHALL additionally register `"shell.env": async (input, output) => { output.env.REMBRIC_PROJECT_DIR = ctx.directory }`. The hook SHALL be omitted otherwise.

The `chat.message` and `message.updated` handlers MUST treat the `sessionMessages` Map as their only side effect. An invariant test (`apps/server/src/test/invariants.test.ts`) SHALL fail the build if either handler invokes `rembricPost`, `fetch`, or any other HTTP work.

#### Scenario: Handler set is exactly the documented set

- **WHEN** the resolved value of `RembricPlugin(ctx)` is inspected
- **THEN** its own enumerable keys are exactly `["event", "chat.message", "message.updated", "session.idle", "experimental.session.compacting"]` plus `"shell.env"` if Plan B is active
- **AND** no other keys exist

### Requirement: Session.created handler with sub-agent filtering

The `event` dispatcher's `"session.created"` branch SHALL extract `event.properties.info.id`, `event.properties.info.parentID`, and `event.properties.info.title`. It SHALL treat a session as a sub-agent (and skip top-level registration) iff `parentID` is truthy OR `title.endsWith(" subagent)")`. Sub-agent session IDs SHALL be stored in a closure-scoped `Set<string>` named `subAgentSessions` so subsequent `tool.execute.after` events for the same id can also skip work.

Non-sub-agent sessions SHALL be registered exactly once per plugin lifetime via an `ensureSession(id)` helper that:

- Returns immediately if `id` is empty.
- Returns immediately if `id` is in `subAgentSessions`.
- Returns immediately if `id` is already in `knownSessions` (a second closure-scoped `Set<string>`).
- Adds `id` to `knownSessions`.
- POSTs `${REMBRIC_SERVER_URL}/api/<slug>/sessions` with body `{"id": <id>, "agent": "opencode", "cwd": <ctx.directory>}` if a slug resolved successfully. The body SHALL OMIT `cwd` entirely (NOT send `null`) when `ctx.directory` is unavailable, matching the bug fix recorded in memory `01KRY3ZAF86NRK5Y8K3N0JJ9M6`.

The handler SHALL emit one stderr diagnostic line per `session.created` event of the form `[rembric] session.created id=<id> parentID=<parentID|""> title=<title|""> subagent=<true|false>`. This is mandatory: it makes engram-style heuristic drift visible in opencode's debug logs (design.md risk register).

#### Scenario: Top-level session is registered exactly once

- **WHEN** `session.created` fires with `info.id="abc"`, `info.parentID=""`, `info.title="Working on widget"`
- **THEN** `ensureSession("abc")` runs and POSTs to `/api/<slug>/sessions` exactly once
- **AND** a second `session.created` with the same id is a no-op (no second POST)

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
2. Push a single string onto `output.context` (the array opencode's compactor consumes) instructing the compactor that the next agent MUST call `memory.session_summary` immediately with the compacted summary content, preserving what was done before compaction. The instruction text SHALL be a single multi-line string ending with a sentence stating that without this step everything before compaction is lost from memory. The text SHALL name the project slug when one was resolved. **The text SHALL ALSO include a final sentence directing the post-compact agent to call `memory.context` if it needs detail beyond the compact summary (file paths, decisions, specific errors not in the compacted block).**

The handler SHALL NOT mutate `input.context` or `input.messages` directly. All effects SHALL be expressed as appends to `output.context`.

The handler SHALL NOT GET any `/context` or recall-context endpoint in v1 — no such endpoint exists on the HTTP API today. When the corresponding endpoint ships in a future OpenSpec change, the handler MAY be extended to prepend a server-returned recall block before the reminder; that prepend SHALL fail silently on any error and the reminder string (including the memory.context guidance) SHALL remain the last (always-present) entry.

#### Scenario: Reminder includes memory.session_summary AND memory.context guidance

- **WHEN** `experimental.session.compacting` fires with a valid `input.sessionID`
- **THEN** `ensureSession` runs (POST `/api/<slug>/sessions` once)
- **AND** exactly ONE string is pushed to `output.context`
- **AND** that string contains the substring `memory.session_summary`
- **AND** that string contains the substring `memory.context` (new requirement — the post-compact recovery path)
- **AND** that string contains the project slug when one was resolved from `.rembric`

#### Scenario: Compacting fires without sessionID

(Unchanged from the prior spec.)

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

`apps/plugin/.opencode-plugin/install.sh` SHALL:

1. Use `#!/usr/bin/env bash` shebang and `set -euo pipefail`.
2. Create `${HOME}/.config/opencode/plugins/` if missing.
3. Create `${HOME}/.config/rembric/bin/` if missing.
4. Copy (not symlink) `apps/plugin/bin/rembric-bridge.mjs` to `${HOME}/.config/rembric/bin/rembric-bridge.mjs`.
5. Copy (not symlink) `apps/plugin/bin/rembric-dotenv.mjs` to `${HOME}/.config/rembric/bin/rembric-dotenv.mjs`. The bridge imports from this file via the relative path `./rembric-dotenv.mjs`, so the two files MUST land together in the same directory.
6. Transform `apps/plugin/.opencode-plugin/plugin.ts` while copying it to `${HOME}/.config/opencode/plugins/rembric.ts`: the source file contains `from '../bin/rembric-dotenv.mjs'` (relative path that resolves at dev time against the monorepo layout); `install.sh` SHALL substitute it with `from '${HOME}/.config/rembric/bin/rembric-dotenv.mjs'` (absolute installed path). Bun's ESM resolver in opencode 1.15.x accepts absolute paths. No other transformation is applied.
7. Set all three copied files to `chmod 644` (the bridge and dotenv lib are invoked as `node <path>`, not directly-executed scripts; the +x bit is unnecessary and reduces attack surface).
8. Print a success banner showing the three destination paths.
9. Print the MCP snippet with `${HOME}` substituted (real absolute path) and `<REMBRIC_SERVER_URL>` / `<REMBRIC_API_TOKEN>` LEFT AS LITERAL PLACEHOLDERS.
10. Exit 0.

The script SHALL NOT touch `~/.config/opencode/opencode.json`. The script SHALL NOT prompt for input. The script SHALL be idempotent: running it twice SHALL leave the system in the same valid state without error.

If any of `apps/plugin/.opencode-plugin/plugin.ts`, `apps/plugin/bin/rembric-bridge.mjs`, or `apps/plugin/bin/rembric-dotenv.mjs` is missing at install time (operator running it from an unfinished checkout), the script SHALL exit non-zero with a clear stderr message naming the missing path.

#### Scenario: Idempotent re-run

- **WHEN** `install.sh` runs twice in succession
- **THEN** both invocations exit 0
- **AND** the destination files exist after each invocation
- **AND** their contents match the source files

#### Scenario: Snippet has expanded $HOME but unexpanded placeholders

- **GIVEN** `$HOME = /Users/alice`
- **WHEN** the install script prints the MCP snippet
- **THEN** the snippet contains the literal string `/Users/alice/.config/rembric/bin/rembric-bridge.mjs`
- **AND** the snippet contains the literal placeholders `<REMBRIC_SERVER_URL>` and `<REMBRIC_API_TOKEN>` (NOT substituted)

#### Scenario: Missing bridge source aborts

- **GIVEN** `apps/plugin/bin/rembric-bridge.mjs` is absent
- **WHEN** `install.sh` runs
- **THEN** the script exits with a non-zero code
- **AND** writes a stderr message naming the missing path

### Requirement: Uninstall script contract

`apps/plugin/.opencode-plugin/uninstall.sh` SHALL:

1. Use `#!/usr/bin/env bash` shebang and `set -uo pipefail` (no `-e` — we want to continue past missing files).
2. Remove `${HOME}/.config/opencode/plugins/rembric.ts` if present.
3. Remove `${HOME}/.config/rembric/bin/rembric-bridge.mjs` if present.
4. Remove `${HOME}/.config/rembric/bin/rembric-dotenv.mjs` if present (the shared dotenv lib copied by `install.sh`).
5. Remove `${HOME}/.config/rembric/bin/` if empty.
6. Remove `${HOME}/.config/rembric/` if empty.
7. Print a final banner listing what was removed and what was NOT removed (e.g., the MCP block in `opencode.json`, which the user must edit manually).
8. Exit 0 even if all targets were absent (idempotent).

The script SHALL NOT touch `~/.config/opencode/opencode.json`. The script SHALL NOT remove the `~/.config/opencode/plugins/` directory itself (it may contain other plugins).

#### Scenario: Idempotent uninstall

- **WHEN** `uninstall.sh` runs against a system where the plugin has already been removed
- **THEN** the script exits 0
- **AND** writes a banner indicating no targets existed

#### Scenario: opencode.json is preserved

- **WHEN** `uninstall.sh` completes
- **THEN** `~/.config/opencode/opencode.json` is unchanged
- **AND** the printed banner instructs the user to remove the `mcp.rembric` block manually

### Requirement: cwd spike gates the plugin's shell.env hook

Before implementation begins, an operator-driven spike SHALL determine whether opencode spawns `type: "local"` MCP subprocesses with the user's repository as `cwd` or sets `PWD` to that directory. The spike steps are documented in tasks.md (phase 0).

The result determines which path ships:

- **Plan A (default)**: If opencode sets cwd or PWD to the user's repo, the bridge resolves the slug correctly via its existing `CLAUDE_PROJECT_DIR > PWD > process.cwd()` chain. The plugin SHALL NOT register `shell.env`. The bridge SHALL NOT change. The plugin SHALL NOT export `REMBRIC_PROJECT_DIR` anywhere.
- **Plan B**: If neither cwd nor PWD reaches the user's repo, the plugin SHALL register a `shell.env` hook that sets `output.env.REMBRIC_PROJECT_DIR = ctx.directory` on every subprocess opencode spawns. The bridge (`apps/plugin/bin/rembric-bridge.mjs`) SHALL gain a new highest-precedence step in its resolution chain: `REMBRIC_PROJECT_DIR > CLAUDE_PROJECT_DIR > PWD > process.cwd()`. The new step SHALL be additive: existing clients that never set `REMBRIC_PROJECT_DIR` SHALL retain their current behaviour unchanged.

The decision SHALL be recorded as a one-line comment near the top of `plugin.ts` of the form `// cwd-spike-result: plan-a` or `// cwd-spike-result: plan-b`. The comment SHALL match the implementation actually shipped.

#### Scenario: Plan A ships without bridge changes

- **GIVEN** the spike confirms opencode spawns subprocesses with the user's repo as cwd or PWD
- **WHEN** the implementation lands
- **THEN** `plugin.ts` contains `// cwd-spike-result: plan-a`
- **AND** `plugin.ts` exports no `"shell.env"` handler
- **AND** `apps/plugin/bin/rembric-bridge.mjs` is unchanged from its pre-change content (its diff against the previous version is empty)

#### Scenario: Plan B ships with additive bridge change

- **GIVEN** the spike confirms opencode does NOT propagate the user's repo via cwd/PWD
- **WHEN** the implementation lands
- **THEN** `plugin.ts` contains `// cwd-spike-result: plan-b`
- **AND** `plugin.ts` exports a `"shell.env"` handler that sets `output.env.REMBRIC_PROJECT_DIR`
- **AND** `apps/plugin/bin/rembric-bridge.mjs` reads `REMBRIC_PROJECT_DIR` as the highest-precedence step of its resolution chain
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

### Requirement: Plugin version managed by release-please as an independent component

The version recorded in `apps/plugin/.opencode-plugin/plugin.ts`'s `// @rembric-plugin-version` comment SHALL track the `opencode-plugin` release-please component's version. opencode is configured as an **independent component** in `release-please-config.json`. There is no `linked-versions` group at all: the Claude Code and Codex surfaces are owned by the single `plugin-shared` component (which bumps them together when shared assets or either client directory change); `opencode-plugin` is separate from it. The rationale: opencode's `install.sh` re-fetches shared assets (`apps/plugin/bin/`, `apps/plugin/scripts/`) from `main` at install time, so shared-asset changes reach opencode installs without requiring a coordinated version bump.

Likewise, `apps/plugin/.hermes-plugin/plugin.yaml::version` is its own independent release-please component for the same reason.

Operators do NOT hand-edit any of the four version surfaces. Conventional Commits drive bumps via release-please.

#### Scenario: opencode-scoped change bumps only the opencode-plugin component

- **WHEN** a Conventional Commit scoped to `opencode` (e.g. `feat(opencode): ...`) lands on `main`
- **THEN** release-please opens (or updates) a release PR that bumps only the `// @rembric-plugin-version` comment in `apps/plugin/.opencode-plugin/plugin.ts` and the manifest entry for the `opencode-plugin` component — `plugin-shared` and `hermes-plugin` are untouched

#### Scenario: Shared-asset change bumps only plugin-shared

- **WHEN** a Conventional Commit modifies a shared file under `apps/plugin/bin/` or `apps/plugin/scripts/`
- **THEN** release-please bumps the single `plugin-shared` component (Claude Code + Codex surfaces) — `hermes-plugin` and `opencode-plugin` remain on their previous versions and pick up the shared change at next install (their installers re-fetch from `main`)

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

The `"session.idle"` handler is the PRIMARY mechanism that delivers the transcript to the server during the session lifetime. It fires once per agent turn (after the assistant response completes and before the next user prompt). The handler SHALL:

1. Return immediately if `input.sessionID` is in `subAgentSessions`.
2. Schedule a debounced flush for `input.sessionID` with a 500ms quiet period. If a prior debounce-timer is pending for the same session id, cancel it and schedule afresh. Implementation note: use `setTimeout` / `clearTimeout` plus a `Map<string, ReturnType<typeof setTimeout>>` to track per-session pending timers.
3. The debounced flush callback SHALL call `flushSessionSummary(sessionId)` (the shared helper used by `server.instance.disposed`), which POSTs `/api/<slug>/sessions/<id>/summary` with body `{summary, title?, final:false}`.

Rationale: opencode's `server.instance.disposed` is fire-and-forget at the runtime level (verified by spike — see design.md::Decision 4 resolved). Async POSTs from that handler don't land. The per-turn flush keeps the server's summary current at all times so that even if `server.instance.disposed` fails to deliver, the row is at-most-one-turn behind reality.

The debounce SHALL NOT exceed 2 seconds (don't accumulate too much state in-flight) and SHALL NOT be below 200ms (don't POST on every keystroke during streaming).

#### Scenario: session.idle fires periodic flush per turn

- **GIVEN** a session "s1" with three user prompts each followed by an assistant response, accumulator contains user+assistant turns
- **WHEN** `session.idle` fires after the third assistant turn
- **THEN** within 500ms a POST to `/api/<slug>/sessions/s1/summary` is issued
- **AND** the body's `summary` contains all six turns

#### Scenario: Rapid-fire session.idle events debounce

- **GIVEN** session.idle fires three times within 100ms for the same session id
- **WHEN** the debounce timer expires
- **THEN** exactly ONE POST is issued (the prior timers were cancelled)

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
2. Extract text from `output.parts` filtering `part.type === "text"`, joining with newlines, and trimming. If empty, fall back to `output.message.summary.title + "\n" + output.message.summary.body` if available.
3. If the resulting text is empty, return without mutating state.
4. Otherwise append `{role: 'user', text: <stripped+truncated>}` to `sessionMessages.get(input.sessionID)` (creating the array if it does not exist).
5. The handler SHALL pass the text through a `stripPrivateTags` helper that replaces `<private>...</private>` blocks (case-insensitive, multiline) with `[REDACTED]`. The handler SHALL truncate each entry to 2000 characters with a `"..."` suffix if longer.
6. The accumulator MUST cap each session's array at 200 entries. If the array reaches the cap, the oldest entry is shifted out (FIFO) before the new entry is appended. This protects against unbounded memory growth in long sessions.

The handler SHALL NOT POST any HTTP request. The accumulated data flows out only via the `server.instance.disposed` flush.

#### Scenario: User text accumulates

- **WHEN** `chat.message` fires three times with sessionID `"s1"` and user text `"hello"`, `"fix the bug"`, `"thanks"`
- **THEN** `sessionMessages.get("s1")` is `[{role:'user', text:'hello'}, {role:'user', text:'fix the bug'}, {role:'user', text:'thanks'}]`
- **AND** no HTTP request is made

#### Scenario: Private tags are redacted before accumulation

- **WHEN** `chat.message` fires with user text `"Connect to <private>postgresql://u:p@host/db</private> and run a count"`
- **THEN** the appended entry's `text` is `"Connect to [REDACTED] and run a count"`

#### Scenario: Sub-agent prompts are skipped

- **GIVEN** `subAgentSessions` contains `"sub-1"`
- **WHEN** `chat.message` fires with `input.sessionID = "sub-1"`
- **THEN** `sessionMessages` does NOT gain an entry for `"sub-1"`

#### Scenario: Accumulator caps at 200 entries

- **GIVEN** `sessionMessages.get("s1").length === 200`
- **WHEN** a 201st `chat.message` fires for `"s1"`
- **THEN** the oldest entry is removed (the array length stays at 200)
- **AND** the newest entry is at the tail

### Requirement: Message.updated handler accumulates assistant transcript

The `"message.updated"` handler SHALL:

1. Return immediately if `input.sessionID` is in `subAgentSessions`.
2. Return immediately if `output.message.role !== 'assistant'`. The handler is a no-op for user messages (which are captured by `chat.message`) and any other roles.
3. Extract text from `output.message.parts` filtering text parts. Apply the same `stripPrivateTags` and truncate-to-2000 transforms as `chat.message`.
4. If the resulting text is empty, return.
5. Search `sessionMessages.get(input.sessionID)` for an existing entry whose `id` field equals `output.message.id`. If found, REPLACE its `text` (preserving the entry's position in the array). If not found, APPEND `{role:'assistant', text, id:<output.message.id>}` to the array.

The handler MUST be idempotent under streaming token updates: opencode may fire `message.updated` many times per assistant turn (token-by-token streaming). The id-keyed replacement ensures only one final-state entry per assistant message in the accumulator.

The 200-entry cap from `chat.message` applies here too — when appending a new assistant entry causes the array to exceed 200, the oldest entry is FIFO-evicted.

#### Scenario: Assistant text is appended on first sight, replaced on subsequent updates

- **GIVEN** `sessionMessages.get("s1")` is `[]`
- **WHEN** `message.updated` fires with `output.message.id="m1"`, `role="assistant"`, accumulating parts that resolve to text `"Hello,"`
- **THEN** `sessionMessages.get("s1")` is `[{role:'assistant', text:'Hello,', id:'m1'}]`
- **WHEN** `message.updated` fires again with the SAME `output.message.id="m1"` and longer text `"Hello, working on it."`
- **THEN** the entry's text is replaced; the array length stays at 1; the entry's position is unchanged
- **WHEN** `message.updated` fires with a different `output.message.id="m2"`, text `"Done."`
- **THEN** `sessionMessages.get("s1")` is `[{role:'assistant', text:'Hello, working on it.', id:'m1'}, {role:'assistant', text:'Done.', id:'m2'}]`

#### Scenario: Non-assistant roles are ignored

- **WHEN** `message.updated` fires with `output.message.role="user"` or `"system"` or `"tool"`
- **THEN** the handler returns without mutating `sessionMessages`

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
