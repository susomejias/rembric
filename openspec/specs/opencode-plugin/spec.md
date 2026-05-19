# opencode-plugin Specification

## Purpose

TBD - created by archiving change add-opencode-plugin. Update Purpose after archive.

## Requirements

### Requirement: Plugin source location

The plugin SHALL live in this monorepo at `plugin/.opencode-plugin/`, sibling to `plugin/.claude-plugin/`, `plugin/.codex-plugin/`, and `plugin/.hermes-plugin/`. The directory SHALL contain exactly four files at the top level: `plugin.ts`, `install.sh`, `uninstall.sh`, `README.md`. A co-located test file `plugin.test.ts` MAY exist alongside `plugin.ts` for vitest-based unit testing of pure helpers (dotenv parser, slug regex, sub-agent filter); the test file is NOT distributed to users.

There SHALL NOT be a `plugin/.opencode-plugin/plugin.json` or `plugin/.opencode-plugin/manifest.yaml` file. opencode has no plugin manifest format; plugins are JS/TS modules in a known directory, identified only by their exported `Plugin` function.

#### Scenario: Plugin tree contains the four files

- **WHEN** the repository is at HEAD
- **THEN** `ls plugin/.opencode-plugin/` lists `plugin.ts`, `install.sh`, `uninstall.sh`, and `README.md`
- **AND** there are no nested directories under `plugin/.opencode-plugin/`
- **AND** there is no `plugin.json`, `plugin.yaml`, or `manifest.*` file

#### Scenario: Co-located test file is permitted

- **WHEN** the repository is at HEAD and unit tests exist for the plugin helpers
- **THEN** `plugin/.opencode-plugin/plugin.test.ts` MAY exist
- **AND** the install script SHALL NOT copy `plugin.test.ts` to the user's machine

### Requirement: Plugin module exports a Plugin function

`plugin/.opencode-plugin/plugin.ts` SHALL export a named const `RembricPlugin` typed as `Plugin` (from `@opencode-ai/plugin`). The export SHALL be an async function that receives the opencode plugin context (`{ project, client, $, directory, worktree }`) and returns an object whose properties are the event handler subscriptions.

The plugin module SHALL be importable in a Node/Bun environment that has `@opencode-ai/plugin` available as a peer dependency. The repository SHALL NOT add `@opencode-ai/plugin` to its own `dependencies` or `devDependencies` — it is consumed only at the user's runtime when opencode loads the plugin file.

A version comment of the form `// @rembric-plugin-version <semver>` SHALL appear in the first 5 lines of `plugin.ts`. opencode has no manifest to declare a version; the comment is the only place to record it for diagnostics and lock-step with `plugin/.claude-plugin/plugin.json::version`.

#### Scenario: Plugin file declares its version

- **WHEN** the file is read at HEAD
- **THEN** one of the first five lines matches `^// @rembric-plugin-version \d+\.\d+\.\d+$`
- **AND** the captured version equals `plugin/.claude-plugin/plugin.json::version`

#### Scenario: Plugin module loads under Bun

- **WHEN** Bun resolves `~/.config/opencode/plugins/rembric.ts` at opencode startup with `@opencode-ai/plugin` available
- **THEN** the import succeeds without error
- **AND** the exported `RembricPlugin` is an async function
- **AND** calling `RembricPlugin(ctx)` returns a Promise whose resolved value is a plain object with event-handler properties

### Requirement: MCP transport reuses the existing stdio bridge

The opencode plugin SHALL reuse `plugin/bin/rembric-bridge.mjs` verbatim — the same file consumed by Claude Code and Codex CLI. The bridge SHALL NOT be forked, copied with modifications, or replaced by an opencode-specific variant.

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

where `<HOME>` is the literal string from `$HOME` at install time. The install script SHALL substitute `<HOME>` with the resolved absolute path before printing the snippet, but SHALL leave `<URL>` and `<TOKEN>` as placeholders for the user to fill in.

The plugin SHALL NOT register its own MCP server programmatically and SHALL NOT use `type: "remote"`. The reasoning is recorded in design.md::Decision 1 (path-scoping requires dynamic URL construction per project, which only the spawned bridge can do).

#### Scenario: Bridge file is reused without divergence

- **WHEN** the repository is at HEAD
- **THEN** `plugin/.opencode-plugin/` contains no `*.mjs` or `*-bridge.*` file
- **AND** the install script copies `plugin/bin/rembric-bridge.mjs` (not a sibling copy) to the user's `~/.config/rembric/bin/`

#### Scenario: MCP snippet uses type: local with the shared bridge path

- **WHEN** the install script runs and prints the MCP snippet
- **THEN** the printed JSON has `mcp.rembric.type = "local"`
- **AND** `mcp.rembric.command` is `["node", "<expanded $HOME>/.config/rembric/bin/rembric-bridge.mjs"]`
- **AND** `mcp.rembric.environment` declares exactly `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` as placeholder values for the user to edit

### Requirement: Slug resolution uses the .rembric convention shared across clients

The bridge spawned by opencode SHALL resolve the project slug by reading `<cwd>/.rembric` and parsing `PROJECT_SLUG=<slug>` from dotenv-style lines (mirroring `_api.sh::rembric_read_project_slug` and the existing bridge contract in `claude-code-plugin::MCP bridge contract`). The slug regex SHALL be exactly `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`.

The plugin's runtime event handlers (that POST directly to `/api/<slug>/sessions/...` over HTTP, bypassing MCP) SHALL replicate the same `.rembric` read-and-validate logic in TypeScript inside `plugin.ts`. The TypeScript implementation SHALL match the bridge's behaviour byte-for-byte: same dotenv grammar (comments with `#`, optional quoted values, trimming), same regex, same fail-silent miss semantics.

A helper named `readRembricSlug(directory: string): string | null` SHALL be exported from `plugin.ts` for unit testability.

The plugin SHALL NOT fall back to git-remote-derived slugs, `package.json::name`, or repository-directory basename. If `.rembric` is missing or the slug is invalid, lifecycle POSTs SHALL skip silently (write one stderr diagnostic line per session, not per event).

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

1. `event: async ({ event }) => ...` — a dispatcher that switches on `event.type` for `"session.created"` and `"session.deleted"`. Any other `event.type` values SHALL be silently ignored.
2. `"experimental.session.compacting": async (input, output) => ...` — post-compaction reminder injection.

The plugin SHALL NOT register `"chat.message"` or `"tool.execute.after"` in v1. Passive prompt and observation capture require corresponding server-side endpoints (`/api/<slug>/prompts/passive`, `/api/<slug>/observations/passive`) that do not yet exist on Rembric's HTTP API (`src/server/api-router.ts` exposes only `POST /sessions`, `POST /sessions/:id/summary`, `POST /sessions/:id/end`). Adding those endpoints is deferred to a separate OpenSpec change; the opencode plugin will gain the handlers once the API is in place.

The plugin SHALL NOT register `experimental.chat.system.transform` (no system-prompt injection in v1). The plugin SHALL NOT register `tool.execute.before` (no tool guards in v1). The plugin SHALL NOT register `permission.asked` or `permission.replied`.

If Plan B of the cwd spike applies (see "cwd spike" requirement), the plugin SHALL additionally register `"shell.env": async (input, output) => { output.env.REMBRIC_PROJECT_DIR = ctx.directory }`. The hook SHALL be omitted otherwise.

#### Scenario: Handler set is exactly the documented set

- **WHEN** the resolved value of `RembricPlugin(ctx)` is inspected
- **THEN** its own enumerable keys are exactly `["event", "experimental.session.compacting"]` plus `"shell.env"` if Plan B is active
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

The `event` dispatcher's `"session.deleted"` branch SHALL remove the session id from `knownSessions`, `subAgentSessions`, and the per-session `toolCounts` map (if present). It SHALL NOT POST any HTTP request. opencode's `session.deleted` fires only on explicit UI delete — it is not a "user quit" signal and SHALL NOT trigger server-side session closure.

Session closure on the server side SHALL rely exclusively on:

- The agent voluntarily calling `memory.session_summary` (cooperating path).
- The server's `abandonStale` periodic task flipping `status='active'` rows to `'abandoned'` after the configured inactivity threshold (non-cooperating path).

#### Scenario: session.deleted is a local-state cleanup

- **GIVEN** session id `"abc"` is in `knownSessions`
- **WHEN** `session.deleted` fires with `info.id="abc"`
- **THEN** `knownSessions` no longer contains `"abc"`
- **AND** no HTTP request is made
- **AND** the server's `sessions` table is NOT modified by this event

### Requirement: Experimental.session.compacting handler

The `"experimental.session.compacting"` handler SHALL:

1. If `input.sessionID` is present, call `ensureSession(input.sessionID)`.
2. Push a single string onto `output.context` (the array opencode's compactor consumes) instructing the compactor that the next agent MUST call `memory.session_summary` immediately with the compacted summary content, preserving what was done before compaction. The instruction text SHALL be a single multi-line string ending with a sentence stating that without this step everything before compaction is lost from memory. The text SHALL name the project slug when one was resolved.

The handler SHALL NOT mutate `input.context` or `input.messages` directly. All effects SHALL be expressed as appends to `output.context`.

The handler SHALL NOT GET any `/context` or recall-context endpoint in v1 — no such endpoint exists on the HTTP API today. When the corresponding endpoint ships in a future OpenSpec change, the handler MAY be extended to prepend a server-returned recall block before the reminder; that prepend SHALL fail silently on any error and the reminder string SHALL remain the last (always-present) entry.

#### Scenario: Reminder is always appended

- **WHEN** `experimental.session.compacting` fires with a valid `input.sessionID`
- **THEN** `ensureSession` runs (POST `/api/<slug>/sessions` once)
- **AND** exactly ONE string is pushed to `output.context`
- **AND** that string contains the substring `memory.session_summary`
- **AND** that string contains the project slug when one was resolved from `.rembric`

#### Scenario: Compacting fires without sessionID

- **WHEN** `experimental.session.compacting` fires with `input.sessionID` absent or empty
- **THEN** `ensureSession` is NOT called
- **AND** the reminder string is still appended to `output.context`

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

`plugin/.opencode-plugin/install.sh` SHALL:

1. Use `#!/usr/bin/env bash` shebang and `set -euo pipefail`.
2. Create `${HOME}/.config/opencode/plugins/` if missing.
3. Create `${HOME}/.config/rembric/bin/` if missing.
4. Copy (not symlink) `plugin/.opencode-plugin/plugin.ts` to `${HOME}/.config/opencode/plugins/rembric.ts`.
5. Copy (not symlink) `plugin/bin/rembric-bridge.mjs` to `${HOME}/.config/rembric/bin/rembric-bridge.mjs`.
6. Set both copied files to `chmod 644` (the bridge is invoked as `node <path>`, not as a directly-executed script; the +x bit is unnecessary and reduces attack surface).
7. Print a success banner showing the two destination paths.
8. Print the MCP snippet with `${HOME}` substituted (real absolute path) and `<REMBRIC_SERVER_URL>` / `<REMBRIC_API_TOKEN>` LEFT AS LITERAL PLACEHOLDERS.
9. Exit 0.

The script SHALL NOT touch `~/.config/opencode/opencode.json`. The script SHALL NOT prompt for input. The script SHALL be idempotent: running it twice SHALL leave the system in the same valid state without error.

If `plugin/bin/rembric-bridge.mjs` is missing at install time (operator running it from an unfinished checkout), the script SHALL exit non-zero with a clear stderr message.

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

- **GIVEN** `plugin/bin/rembric-bridge.mjs` is absent
- **WHEN** `install.sh` runs
- **THEN** the script exits with a non-zero code
- **AND** writes a stderr message naming the missing path

### Requirement: Uninstall script contract

`plugin/.opencode-plugin/uninstall.sh` SHALL:

1. Use `#!/usr/bin/env bash` shebang and `set -uo pipefail` (no `-e` — we want to continue past missing files).
2. Remove `${HOME}/.config/opencode/plugins/rembric.ts` if present.
3. Remove `${HOME}/.config/rembric/bin/rembric-bridge.mjs` if present.
4. Remove `${HOME}/.config/rembric/bin/` if empty.
5. Remove `${HOME}/.config/rembric/` if empty.
6. Print a final banner listing what was removed and what was NOT removed (e.g., the MCP block in `opencode.json`, which the user must edit manually).
7. Exit 0 even if all targets were absent (idempotent).

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
- **Plan B**: If neither cwd nor PWD reaches the user's repo, the plugin SHALL register a `shell.env` hook that sets `output.env.REMBRIC_PROJECT_DIR = ctx.directory` on every subprocess opencode spawns. The bridge (`plugin/bin/rembric-bridge.mjs`) SHALL gain a new highest-precedence step in its resolution chain: `REMBRIC_PROJECT_DIR > CLAUDE_PROJECT_DIR > PWD > process.cwd()`. The new step SHALL be additive: existing clients that never set `REMBRIC_PROJECT_DIR` SHALL retain their current behaviour unchanged.

The decision SHALL be recorded as a one-line comment near the top of `plugin.ts` of the form `// cwd-spike-result: plan-a` or `// cwd-spike-result: plan-b`. The comment SHALL match the implementation actually shipped.

#### Scenario: Plan A ships without bridge changes

- **GIVEN** the spike confirms opencode spawns subprocesses with the user's repo as cwd or PWD
- **WHEN** the implementation lands
- **THEN** `plugin.ts` contains `// cwd-spike-result: plan-a`
- **AND** `plugin.ts` exports no `"shell.env"` handler
- **AND** `plugin/bin/rembric-bridge.mjs` is unchanged from its pre-change content (its diff against the previous version is empty)

#### Scenario: Plan B ships with additive bridge change

- **GIVEN** the spike confirms opencode does NOT propagate the user's repo via cwd/PWD
- **WHEN** the implementation lands
- **THEN** `plugin.ts` contains `// cwd-spike-result: plan-b`
- **AND** `plugin.ts` exports a `"shell.env"` handler that sets `output.env.REMBRIC_PROJECT_DIR`
- **AND** `plugin/bin/rembric-bridge.mjs` reads `REMBRIC_PROJECT_DIR` as the highest-precedence step of its resolution chain
- **AND** the bridge's behaviour when `REMBRIC_PROJECT_DIR` is unset is byte-identical to its pre-change behaviour

### Requirement: README documents the two-step install

`plugin/.opencode-plugin/README.md` SHALL document the install in exactly two steps in this order:

1. Run `bash install.sh` (or `curl ... | bash` shorthand if the operator publishes one).
2. Paste the printed MCP snippet into `~/.config/opencode/opencode.json` (or the project's `./opencode.json`), filling in `<REMBRIC_SERVER_URL>` and `<REMBRIC_API_TOKEN>`. Restart opencode.

The README SHALL include:

- An "Update" section explaining that opencode does not cache plugins by version, so updating means re-running `install.sh` (which overwrites the two installed files).
- A "Verify" section showing how to confirm the install: opening opencode in a `.rembric`-equipped repo, opening a session, observing one `[rembric] session.created` stderr line in opencode's debug logs.
- A "Troubleshooting" section listing the three most likely failure modes: missing `.rembric` (plugin silently no-ops the session POST), missing env vars in the MCP block (bridge exits 1 and opencode shows a connection error), opencode version older than the supported floor (handler API mismatch).

The README SHALL NOT include an "npm install" path.

#### Scenario: README has exactly two install steps in order

- **WHEN** the file is read
- **THEN** the install section lists step 1 (run install.sh) before step 2 (paste MCP snippet)
- **AND** there is no third step before "Verify"
- **AND** no section mentions npm

### Requirement: Plugin version lock-step

The version recorded in `plugin/.opencode-plugin/plugin.ts`'s `// @rembric-plugin-version` comment SHALL equal:

- `plugin/.claude-plugin/plugin.json::version`
- `plugin/.codex-plugin/plugin.json::version`
- `plugin/.hermes-plugin/plugin.yaml::version`

These four values SHALL move together. Any commit that bumps one of them SHALL bump all four. A `plugin/CHANGELOG.md` entry SHALL describe the change in the same commit. The lock-step rule is enforced by an existing invariant test (`src/test/invariants.test.ts` or sibling) that SHALL be extended to read the `// @rembric-plugin-version` comment as a fourth value.

#### Scenario: All four version sources match

- **WHEN** the invariant test runs at HEAD
- **THEN** it reads `plugin.json::version` from both `.claude-plugin` and `.codex-plugin`, `plugin.yaml::version` from `.hermes-plugin`, AND the `// @rembric-plugin-version` comment from `plugin/.opencode-plugin/plugin.ts`
- **AND** all four values are equal
- **AND** the test fails with a clear message if any single value diverges

### Requirement: Docs and dashboard help mention opencode

`README.md`, `docs/agents.md`, and the dashboard's connection-help copy (wherever Claude Code / Codex CLI / Hermes Agent are listed as supported clients) SHALL list "opencode" as a fourth supported client. The opencode entry SHALL link to `plugin/.opencode-plugin/README.md` for setup instructions.

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
