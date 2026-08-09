# pi-plugin Specification

## Purpose

Owns Rembric's Pi client: the extension tree at `apps/plugin/.pi-plugin/`, the npm package `@rembric/pi` that distributes it, and the runtime MCP proxy that gives it a tool surface.

Pi is the odd client out, and most of this capability follows from one fact about the host: it intentionally ships no built-in MCP client, so `apps/plugin/bin/rembric-bridge.mjs` — the stdio↔HTTP proxy every other client's tools arrive through — has no consumer here. The extension therefore **is** the MCP client. It opens Streamable HTTP against `/mcp/<slug>`, calls `tools/list`, and registers whatever it finds. Tools are discovered, never enumerated: the server stays the only place the surface is described, so the plugin and the server cannot desynchronise.

Three further consequences shape the rest. The harness's package gallery lists by keyword with no admission process, so the npm package is not a convenience but the **only** discovery path — which makes publication part of the client's contract, carried as one more `extra-files` version carrier of the unified `plugin` component and never as a release-please component of its own. A real provider was measured refusing the server's dotted tool names outright, rejecting the whole payload rather than the offending tool, so registration maps `.`→`_` while `tools/call` keeps the canonical name. And the harness awaits its session-shutdown handler, so this client's final flush is a guarantee rather than the best-effort dispose the opencode host forces — with measured exceptions that are narrower than first published: a single interrupt reaches no handler in either mode, and print mode registers no `SIGINT` at all, but two interrupts within 500 ms in the interactive TUI run the same awaited shutdown as Ctrl-D.

Cross-client session-protocol logic is **not** owned here. It lives in `apps/plugin/bin/rembric-plugin-core.mjs` and is specified by `plugin-session-protocol`; this capability owns only what is Pi-specific. The outbound rules the npm publication must satisfy are owned by `supply-chain-hygiene`, and the installer backend that drives `pi install` by `tui-installer`.

## Requirements

### Requirement: Extension source location and contents

The Pi extension SHALL live in this monorepo at `apps/plugin/.pi-plugin/`, sibling to `apps/plugin/.claude-plugin/`, `apps/plugin/.codex-plugin/`, `apps/plugin/.hermes-plugin/`, and `apps/plugin/.opencode-plugin/`. The directory SHALL contain exactly four files at the top level: `package.json`, `index.ts`, `README.md`, and `plugin.test.ts`. There SHALL be no nested directories.

`plugin.test.ts` is a development artifact and SHALL NOT be published in the npm tarball.

The directory SHALL NOT contain a copy of any shared resource — the session-protocol core, the nudge strings, the redaction helper, the slug parser, or the `apps/plugin/commands/*.md` prompt templates. Shared resources are referenced at source time and materialised into the tarball at publish time (see the publication requirement).

`apps/plugin/.pi-plugin/` deliberately does NOT match `pnpm-workspace.yaml::packages` (`apps/*`, `packages/*`), so `pnpm -r` does not reach it, `pnpm install` does not link it, and ESLint — which ignores `apps/plugin/*/**` — does not lint it. This is the same condition `apps/plugin/.claude-plugin/package.json` is already in. It is accepted because the directory has to sit inside the `plugin` component's own `path` for a commit touching only this client to trigger a `plugin` release at all, which is what keeps the five carriers in lock-step; the shape of the `extra-files` path is a consequence, not the reason. The extension SHALL therefore declare **no runtime dependencies** whose absence would break it (see the transport requirement).

#### Scenario: Extension tree contains exactly the four files

- **WHEN** the repository is at HEAD
- **THEN** `ls apps/plugin/.pi-plugin/` lists `package.json`, `index.ts`, `README.md`, and `plugin.test.ts`
- **AND** there are no nested directories under `apps/plugin/.pi-plugin/`

#### Scenario: No shared resource is duplicated into the extension directory

- **WHEN** the repository is at HEAD
- **THEN** `apps/plugin/.pi-plugin/` contains no file whose content duplicates `apps/plugin/bin/rembric-plugin-core.mjs`, `apps/plugin/bin/rembric-dotenv.mjs`, `apps/plugin/test/nudge-fixtures.json`, or any file under `apps/plugin/commands/`
- **AND** `git ls-files apps/plugin/` shows exactly one tracked copy of each of those resources

### Requirement: The extension SHALL import shared session-protocol logic, never reimplement it

`apps/plugin/.pi-plugin/index.ts` SHALL obtain the nudge strings, `stripPrivateTags`, the truncation helpers, the stderr diagnostic, the session HTTP client, the transcript accumulator, the summary-body builder, the flush helpers and the session-end call from `apps/plugin/bin/rembric-plugin-core.mjs`. It SHALL NOT declare its own copy of any of them.

The session-end call SHALL live in the shared core even though this is the only client that invokes it, because the core is the single implementation of the session HTTP client (see the `plugin-session-protocol` capability) and a second `fetch` against a `/sessions/…` path written in a client file is a second copy of that client by construction.

The core module SHALL require `agent` as a mandatory parameter of session registration, with **no default value**. `sessions.agent` is written once per session and memory is append-only, so a defaulted value registers sessions under the wrong agent permanently, with no repair verb. The hand-written type declaration `apps/plugin/bin/rembric-plugin-core.d.mts` SHALL declare `agent` as a required property so an omission is a compile error in the TypeScript clients.

#### Scenario: The extension imports the core rather than copying it

- **WHEN** `apps/plugin/.pi-plugin/index.ts` is read at HEAD
- **THEN** it contains an import statement referencing `rembric-plugin-core.mjs`
- **AND** it declares no local `function stripPrivateTags`, no local nudge string constant, and no local session-POST helper

#### Scenario: The session-end call is imported, not written in the client

- **WHEN** `apps/plugin/.pi-plugin/index.ts` is read at HEAD
- **THEN** it SHALL contain no `fetch` call against a path containing `/sessions/`
- **AND** the end SHALL be reached through the core's exported session-end function

#### Scenario: Omitting `agent` is a compile error

- **WHEN** a call to the core's session-registration entry point omits `agent`
- **AND** `tsc` typechecks a TypeScript client against `rembric-plugin-core.d.mts`
- **THEN** typechecking SHALL fail
- **AND** no default agent value SHALL be substituted at runtime

### Requirement: Tools are discovered at runtime over MCP and never enumerated in the plugin

The extension SHALL obtain its tool surface by calling `tools/list` against the running server and registering each returned tool with the harness, proxying each `execute` invocation to `tools/call`. The extension SHALL NOT contain a list, map, array, or switch of tool names, nor a copy of any tool's input schema.

Each registered tool SHALL carry the server's own `description` and `inputSchema` with their **structure** unaltered — no key added, removed, or reordered, no constraint weakened. The single transformation permitted is the tool-name spelling, and it SHALL be applied consistently: to the registered name, and to every model-facing string this client publishes that names a tool (the description, every `description` nested in the schema, and the injected nudges). Renaming the name while leaving the prose dotted would hand the model guidance that names tools its own registry does not contain — the client renames, so the client owns the renaming everywhere it speaks.

Tool **results** SHALL NOT be rewritten: a saved memory's content is the user's text and may legitimately contain a dotted name.

Consequently, adding, renaming, or removing a server tool SHALL require no change to this extension, and the plugin and server tool surfaces cannot desynchronise because only one of them describes the surface.

Because the `inputSchema` travels verbatim, the harness validates arguments against the same schema object the server enforces, so `additionalProperties: false` is applied twice — once before `execute` runs and once on the server. **Only the server-side half is reachable from this repository's suite, and the requirement below says so rather than crediting the suite with the other half.** Driving the harness's validator means importing `@earendil-works/pi-ai`, which carries five provider SDKs — the inbound cost design D7 refuses for this client — so the pre-`execute` half is evidenced **out of band**, by a real harness run, with its measurement recorded in `tasks.md` (3.8). What the suite carries is the server-side refusal, its passing control, and the forwarding assertions that make the two layers see the same schema; a test that calls `execute` directly bypasses the harness's `parameters` handling and therefore evidences the server, not the harness.

#### Scenario: Every server tool is registered with no per-tool plugin code

- **GIVEN** the server registers N tools (N is 23 at the time of writing, at `apps/server/src/mcp/server.ts`)
- **WHEN** the extension initialises against that server
- **THEN** exactly N tools SHALL be registered with the harness
- **AND** each registered tool SHALL correspond to exactly one server tool under the name mapping fixed by the provider-safe-names requirement, with no tool dropped and none invented

#### Scenario: The plugin source contains no tool inventory

- **WHEN** `apps/plugin/.pi-plugin/index.ts` is read at HEAD
- **THEN** it contains no occurrence of any server tool name as a literal (for example `memory.save`, `memory.search`, `memory.judge`) outside of comments and test fixtures

#### Scenario: A proxied call reaches the database

- **GIVEN** a running server and an initialised extension
- **WHEN** the harness invokes the registered `memory.save` tool with a valid title and content
- **THEN** the proxied `tools/call` SHALL return a non-error result
- **AND** an independent `memory.get` on the returned id SHALL return the saved row
- **AND** the control — `memory.get` on an id that was never saved — SHALL return `not_found`

#### Scenario: The forwarded schema is the one both layers enforce

- **WHEN** the value registered as the harness's `parameters` is compared with the server's own `inputSchema`
- **THEN** it SHALL be structurally identical, `$schema` and `additionalProperties: false` included, differing only in the tool-name spellings inside `description` strings
- **AND** a test SHALL go red if anything is stripped from it

#### Scenario: The server refuses a malformed payload (the in-suite half)

- **WHEN** a proxied `tools/call` carries an unknown property, an invalid enum member, or a missing required property
- **THEN** the server SHALL refuse each one against its own strict schema
- **AND** the control — the same call with a valid payload — SHALL succeed
- **AND** this is the boundary the suite exercises: it drives `execute`, so it evidences the server's enforcement and SHALL NOT be described as evidence about the harness

#### Scenario: The harness refuses before `execute` runs (measured out of band)

- **GIVEN** the harness's validator is unreachable from this repository's suite without adding `@earendil-works/pi-ai` and the five provider SDKs it carries
- **WHEN** a real harness run invokes a registered tool with an unknown property, an invalid enum member, or a missing required property
- **THEN** each SHALL be refused with the **harness's** own validation message, before `execute` runs
- **AND** the database SHALL hold no row from any refused call, which is what shows no `tools/call` was sent
- **AND** the evidence SHALL be recorded with its provenance in `tasks.md` rather than attributed to the suite

### Requirement: MCP transport is Streamable HTTP with a Bearer token and no runtime dependency

The extension SHALL connect to `${REMBRIC_SERVER_URL}/mcp/<slug>` over Streamable HTTP, sending `Authorization: Bearer ${REMBRIC_API_TOKEN}`, and SHALL implement exactly the wire surface it needs: `initialize`, the initialized notification, `tools/list`, and `tools/call`.

The extension SHALL declare **no runtime `dependencies`**. The harness's own packages SHALL be declared as `peerDependencies` with the range `"*"` and SHALL NOT be bundled: they are the host, present by construction, and a narrower range would assert a compatibility claim broader than what has been measured.

The reason no runtime dependency is permitted is measured behaviour of the harness's installer, not preference: for a local-path installation the harness does **not** run `npm install` (it does for registry and git specs), so a declared runtime dependency would be absent in exactly the install shape used for development and testing.

Because the extension connects to `/mcp/<slug>`, the server resolves its project through the existing path-scoping contract (`apps/server/src/mcp/_shared.ts::resolveEffectiveScope`): the connection is fixed to that one project and no tool argument can name another. This extension introduces no new scope-resolution path.

#### Scenario: Package declares no runtime dependencies

- **WHEN** `apps/plugin/.pi-plugin/package.json` is read at HEAD
- **THEN** it declares no `dependencies` key, or a `dependencies` key whose value is an empty object
- **AND** the harness packages appear under `peerDependencies` with the range `"*"`
- **AND** no `bundledDependencies` / `bundleDependencies` key is present

#### Scenario: Local-path install works with nothing installed

- **GIVEN** the extension is installed from a local path, so the harness runs no dependency install
- **WHEN** a session starts
- **THEN** tool discovery and registration SHALL succeed
- **AND** no module-resolution error SHALL be emitted

#### Scenario: A slug naming no project is refused, not widened

- **GIVEN** `.rembric` names a `PROJECT_SLUG` for which no project exists
- **WHEN** the extension initialises
- **THEN** the server SHALL refuse the connection with `project_not_found`
- **AND** the extension SHALL NOT fall back to the default project

### Requirement: Credentials come from the environment and the slug from `.rembric`

The extension SHALL read `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from `process.env`, matching how the Hermes plugin and the in-process side of the opencode plugin already obtain them. The harness does not inject environment variables from its own settings file, so no settings-file credential path SHALL be documented or implemented.

The project slug SHALL be resolved from `.rembric::PROJECT_SLUG` via `readRembricSlug` from `apps/plugin/bin/rembric-dotenv.mjs`. The extension SHALL NOT parse `.rembric` itself and SHALL NOT declare its own slug regex.

When either environment variable is absent the extension SHALL disable itself, SHALL emit exactly one one-line stderr diagnostic naming which configuration is missing, and SHALL NOT break the host harness. The diagnostic SHALL NOT include the token.

Stderr is not visible in the harness's TUI, so a disabled extension is otherwise indistinguishable from a working one: the operator sees it load, sees its prompt templates, and gets no tools and no reason. The extension SHALL therefore also surface the reason through the harness's own notification channel, at `warning` severity when configuration is missing and `error` severity when the handshake fails. The notification SHALL NOT include the token. Where the harness supplies no notification channel the extension SHALL fall back to stderr alone rather than throw, since the channel is a diagnostic and its absence SHALL NOT cost the operator a working extension.

The reason string SHALL come from `createSessionProtocol`, which already derives it to write the stderr line; the extension SHALL NOT re-derive which configuration is missing, so a reason added to the shared core cannot be misreported here.

#### Scenario: Missing credentials disable the extension without breaking the host

- **GIVEN** `REMBRIC_API_TOKEN` is unset
- **WHEN** the harness loads the extension and starts a session
- **THEN** exactly one stderr line SHALL be emitted naming the missing configuration
- **AND** the line SHALL NOT contain any token value
- **AND** the session SHALL proceed with no Rembric tools registered and no thrown error

#### Scenario: A disabled extension says so in the harness UI, not only on stderr

- **GIVEN** `REMBRIC_API_TOKEN` is unset
- **WHEN** the harness loads the extension and starts a session
- **THEN** exactly one notification SHALL be raised at `warning` severity naming the missing configuration
- **AND** the notification SHALL NOT contain any token value

#### Scenario: A failed handshake says so in the harness UI

- **GIVEN** the configured address accepts connections and never answers
- **WHEN** the harness starts a session
- **THEN** one notification SHALL be raised at `error` severity reporting that the tools are unavailable
- **AND** the notification SHALL NOT contain any token value

#### Scenario: A harness without a notification channel still loads

- **GIVEN** the harness supplies no notification channel on the session context
- **AND** `REMBRIC_API_TOKEN` is unset
- **WHEN** the harness loads the extension and starts a session
- **THEN** the stderr diagnostic SHALL still be emitted
- **AND** no error SHALL be thrown out of the handler

#### Scenario: Slug resolution uses the shared parser

- **WHEN** `apps/plugin/.pi-plugin/index.ts` is read at HEAD
- **THEN** it imports `readRembricSlug` from the shared dotenv module
- **AND** it declares no local `function parseDotenv` and no local `SLUG_RE`

### Requirement: Slash commands reuse the shared command markdown

The extension SHALL expose the four shared command files `apps/plugin/commands/{context,recall,remember,summary}.md` as the harness's prompt templates. `apps/plugin/commands/` SHALL remain their only tracked copy: no per-client duplicate is introduced, and the frontmatter `description` and `$ARGUMENTS` placeholder are consumed as-is.

Because those files name tools in the canonical dotted spelling and this client registers the provider-safe spelling, the copies materialised into the tarball SHALL carry the renamed spellings, applied by the same publish step that materialises them and by the same rename the client applies to its other model-facing strings. The tracked originals SHALL be left byte-identical — the rename exists only in generated output.

Consequently `pi.prompts` SHALL name **only** the materialised location. Pointing it additionally at the tracked originals would make a local-path install serve the un-renamed spellings, which is the defect this requirement exists to prevent; a local-path install therefore has no prompt templates unless the materialise step was run, and that is the intended trade — a missing slash command is visible, guidance naming a tool that does not exist is silent.

#### Scenario: A shared command is available as a prompt template

- **GIVEN** the extension is installed from a materialised package
- **WHEN** the operator invokes the slash command corresponding to `apps/plugin/commands/summary.md`
- **THEN** the harness SHALL expand it to that file's body with `$ARGUMENTS` substituted
- **AND** the description shown SHALL be that file's frontmatter `description`
- **AND** every tool named in the expansion SHALL be a name the extension actually registered

#### Scenario: The tracked originals are never rewritten

- **WHEN** the materialise step has run
- **THEN** `git diff --quiet -- apps/plugin/commands/` SHALL report no change

#### Scenario: The control — uninstalled, the command does not expand

- **GIVEN** the extension is not installed
- **WHEN** the operator types the same slash command
- **THEN** it SHALL remain literal text and SHALL NOT expand

### Requirement: Tools are registered under provider-safe names and proxied to the canonical dotted name

Every tool this extension registers SHALL carry a name matching `^[a-zA-Z0-9_-]+$`, derived from the server's canonical name by replacing each `.` with `_`. The extension SHALL retain the canonical name and SHALL issue `tools/call` with it, so the server only ever receives its own tool names.

**This is a measured hard requirement, not a precaution.** Against a real provider (an OAuth-authenticated Codex provider, model `gpt-5.6-terra`), registering the server's dotted names verbatim fails the whole request:

> `Codex error: [StringParam] [tools[4].name] [invalid_string] Invalid 'tools[4].name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.`

The harness itself performs no name validation or normalisation, so the dot reaches the provider untouched and **all** tools are rejected together — the client is inert, not degraded. The discriminating control: the identical run with the tool payload suppressed exits 0, which isolates the tool definitions as the cause rather than credentials, transport, or the harness. Re-running with `.`→`_` applied at registration exits 0 and a model-driven tool call round-trips to the server under its canonical name.

The mapping SHALL live at registration and SHALL NOT be implemented as a pre-provider-request payload rewrite. A hook that rewrites only the outbound payload cannot work: the model then names the sanitised tool in its tool call, and the harness resolves that name against its own registry, where nothing is registered under it.

The same measurement showed the provider accepting the server's `inputSchema` **verbatim** — including the draft-07 `$schema` key the harness forwards inside `parameters`, `additionalProperties: false`, and the `"strict": false` the harness adds itself. Stripping `$schema` is therefore NOT required for this provider and SHALL NOT be done speculatively. Should another provider reject a forwarded schema key, the pre-provider-request hook is the correct place for that repair, and the repair SHALL be justified by a measurement against the provider that rejected it.

#### Scenario: Registered names are provider-safe

- **WHEN** the extension registers the tools returned by `tools/list`
- **THEN** every registered name SHALL match `^[a-zA-Z0-9_-]+$`
- **AND** no registered name SHALL contain `.`

#### Scenario: A safe name round-trips to the canonical tool name

- **GIVEN** a tool whose canonical name contains `.`
- **WHEN** the model requests the safe name
- **THEN** the extension SHALL issue `tools/call` with the canonical dotted name
- **AND** the server SHALL NOT receive the safe form

#### Scenario: The dotted-name failure is covered by a test

- **WHEN** the registration path is changed so a canonical dotted name reaches registration unmapped
- **THEN** a test SHALL fail naming the provider name-pattern constraint

### Requirement: The npm package `@rembric/pi` is the distribution channel, with bounded tarball contents

The extension SHALL be published to the public npm registry as `@rembric/pi`. This is the only mechanism by which the harness's users discover and install it: the package gallery lists by the `pi-package` keyword with no admission process.

`apps/plugin/.pi-plugin/package.json` SHALL declare `"keywords": ["pi-package"]` (the sole listing requirement), a `description` and a `license`, and SHALL NOT declare `"private": true`. Its README is the gallery card. Where the manifest carries an image reference, it SHALL point at a stable raw URL of a tracked repository asset.

The tarball contents SHALL be bounded by an explicit `files` allowlist. Shared resources that must travel in the tarball (the plugin core, the shared dotenv module, the command markdown) SHALL be materialised into the package directory by an **explicit CI step** run before publish. The nudge fixture SHALL NOT travel: it is read only by tests (`git grep nudge-fixtures -- apps/plugin` reaches three test files and one script comment; neither the extension nor the core reads it at runtime), and shipping a test fixture would widen the tarball past what the extension needs to run.

The package SHALL declare **no lifecycle scripts of its own** — in particular no `prepack`. Measured with a positive and a negative control: whether a `prepack` runs depends on the working directory of the publish command, because the project `.npmrc` resolves from the nearest `package.json`, so the repository root's `ignore-scripts=true` does not cover a package published from its own directory but does cover one published from the root. A materialisation step whose execution depends on the invoking directory can silently produce a tarball missing its shared resources with no error, and SHALL NOT be used.

`npm pack --dry-run` SHALL be asserted against an expected file list in CI, so a missing shared resource or an unintended inclusion fails the job rather than shipping.

#### Scenario: Package manifest carries the listing keyword and is publishable

- **WHEN** `apps/plugin/.pi-plugin/package.json` is read at HEAD
- **THEN** `keywords` SHALL contain `pi-package`
- **AND** `private` SHALL be absent or `false`
- **AND** `files` SHALL be present and non-empty

#### Scenario: No lifecycle script is declared

- **WHEN** `apps/plugin/.pi-plugin/package.json` is read at HEAD
- **THEN** it SHALL declare no `prepack`, `prepare`, `prepublishOnly`, `preinstall`, `install`, or `postinstall` script

#### Scenario: A missing shared resource fails the pack assertion

- **GIVEN** the CI materialisation step is skipped or fails to copy one shared resource
- **WHEN** the asserted `npm pack --dry-run` runs
- **THEN** it SHALL fail naming the missing path
- **AND** no publish SHALL occur

#### Scenario: Development artifacts do not ship

- **WHEN** the packed tarball's file list is inspected
- **THEN** it SHALL NOT contain `plugin.test.ts`

### Requirement: Publication is gated on a plugin release and uses trusted publishing

The publish job SHALL live in `.github/workflows/release-please.yml` and SHALL be gated on the release-please output indicating that the `apps/plugin` component was released (`steps.release.outputs['apps/plugin--release_created']`, the plugin analogue of the existing `apps/server` output). It SHALL NOT run on a `server`-only release, and it SHALL NOT run on a merge that produced no release.

The workflow SHALL declare `permissions: id-token: write` and SHALL authenticate to the registry by trusted-publishing OIDC. A long-lived publish credential (`NPM_TOKEN` or equivalent) SHALL NOT be added to the repository.

#### Scenario: A server-only release does not publish

- **GIVEN** a release-please PR bumping only the `server` component is merged
- **WHEN** `release-please.yml` runs to completion
- **THEN** the npm publish job SHALL be skipped (status `skipped`, not `failed`)

#### Scenario: A plugin release publishes with provenance

- **GIVEN** a release-please PR bumping the `plugin` component is merged
- **WHEN** `release-please.yml` runs to completion
- **THEN** the npm publish job SHALL run and SHALL publish `@rembric/pi` at the new plugin version
- **AND** the published version SHALL carry provenance
- **AND** no long-lived registry token SHALL appear in the workflow or repository secrets for this purpose

### Requirement: The package version is the unified plugin version, updated in lock-step

`apps/plugin/.pi-plugin/package.json::version` SHALL be a version carrier of the single unified `plugin` release-please component (path `apps/plugin`, package `@rembric/plugin`, tag `plugin-vX.Y.Z`), declared as the plain relative `extra-files` entry `".pi-plugin/package.json"`.

Pi SHALL NOT be a release-please component of its own, SHALL NOT have its own tag line, and SHALL NOT carry an independent npm version. `.release-please-manifest.json` SHALL continue to declare exactly two entries. The directory SHALL sit inside the component's `path` because release-please attributes a release to a component by the paths of the commits under that `path` — so a Pi-only commit SHALL trigger a `plugin` release exactly as a commit to any other client does. A carrier placed outside `apps/plugin/` would still be _writable_ by release-please (a leading-slash `extra-files` path resolves against the repository root), but would never _cause_ a release, so the lock-step guarantee would be lost.

All plugin clients SHALL share the one `plugin` version and SHALL never diverge. A Pi-only change therefore bumps the shared number for every client; the CHANGELOG, scoped by conventional commit, records what actually changed.

#### Scenario: A Pi-only change bumps the unified plugin component

- **WHEN** a Conventional Commit touching only `apps/plugin/.pi-plugin/` lands on `main`
- **THEN** release-please SHALL open or update a release PR for the `plugin` component only
- **AND** the new version SHALL be written to `.pi-plugin/package.json` alongside every other client carrier in the same PR
- **AND** no `pi-plugin` component and no `pi-plugin-v*` tag SHALL exist

#### Scenario: Version drift is release-blocking

- **WHEN** `apps/plugin/.pi-plugin/package.json::version` disagrees with the `apps/plugin` manifest entry or with the most recent `plugin-vX.Y.Z` tag
- **THEN** the disagreement SHALL be treated as a release-blocking bug
- **AND** release-please SHALL be the only writer of that field

#### Scenario: The manifest still declares exactly two entries

- **WHEN** `.release-please-manifest.json` is read at HEAD
- **THEN** it SHALL declare exactly two entries, `apps/server` and `apps/plugin`

### Requirement: The documented install command SHALL NOT pin a version

The canonical install command documented everywhere SHALL be `pi install npm:@rembric/pi`, with no version suffix.

Measured against the harness's documented behaviour: a package spec that names a version is treated as pinned, and pinned extensions are skipped by both its update-extensions and update-all commands. Documenting a version therefore freezes that operator at that version indefinitely while the update command reports success and does nothing. No documentation, README, skill, or installer output SHALL present a version-pinned install command as the recommended path.

#### Scenario: No documented command carries a version

- **WHEN** every tracked file that documents the install command is inspected (README, `docs/agents.md`, the extension README, the installer output, the skills)
- **THEN** each occurrence SHALL be `pi install npm:@rembric/pi` with no `@<version>` suffix

#### Scenario: The pin's consequence is documented once

- **WHEN** the extension README's update section is read
- **THEN** it SHALL state that a version-pinned install is skipped by the harness's update commands, and that updating means re-running the unpinned install

### Requirement: The extension's tests SHALL actually execute

`apps/server/vitest.config.ts::test.include` SHALL capture every per-client test file **by directory shape** — one glob whose directory segment is a pattern matching the dot-prefixed `*-plugin` manifest directories under `apps/plugin/` — rather than one literal glob per client. The failure this closes is a test file that is written, committed, reviewed and never run: a green suite that executes none of its assertions. A per-client literal only forbids that for the clients someone remembered to enumerate; a shape glob makes it structurally impossible for the next one too, with no config edit at all.

The test SHALL exercise the extension against a **real in-process MCP server** over a temporary SQLite file, not a mocked transport: it SHALL assert the discovered tool count, that registration covers every discovered tool, that a proxied save reaches the database as read back by an independent tool call, and it SHALL include the discriminating control that a fabricated id returns `not_found`.

#### Scenario: The include list matches client directories by shape, not by name

- **WHEN** `apps/server/vitest.config.ts` is read at HEAD
- **THEN** `test.include` SHALL contain a glob whose directory segment is a pattern spanning the per-client manifest directories under `apps/plugin/`
- **AND** no client's tests SHALL depend on an entry naming that client's directory literally

#### Scenario: A client directory added later is collected with no config edit

- **GIVEN** the `include` list at HEAD
- **WHEN** a test file is placed in a `apps/plugin/.<name>-plugin/` directory that no `include` entry names
- **THEN** the file SHALL appear in the collected test-file list without any change to `apps/server/vitest.config.ts`

#### Scenario: The suite runs the extension's tests

- **WHEN** `pnpm test` runs
- **THEN** the reported test files SHALL include `apps/plugin/.pi-plugin/plugin.test.ts`
- **AND** its assertions SHALL include a non-zero discovered-tool count

### Requirement: Pi is listed as a supported client everywhere clients are enumerated

Every tracked surface that enumerates Rembric's bundled clients SHALL include Pi: `README.md` (the tagline, the supported-agents table, and the architecture diagram's client count), `docs/agents.md` (its lead sentence, its per-client section, and the redaction section's client list), `CLAUDE.md` (the architecture paragraph, the plugin-development rules, and the legitimate-divergence list, which SHALL name `.pi-plugin/`), `apps/plugin/README.md`, `apps/plugin/package.json::description`, `apps/server/src/mcp/instructions.ts`'s header comment, and the `rembric-plugin-development`, `rembric-tui-installer`, and `rembric-tui-installer-e2e` skills.

A surface that says "four clients" after this change is a documentation defect, not a stylistic lag.

#### Scenario: No surface still claims four clients

- **WHEN** `git grep -in "four clients\|FOUR clients\|all four"` runs over tracked files, excluding `openspec/changes/archive/**`
- **THEN** every remaining occurrence SHALL be either historically scoped (describing a state before this change) or corrected to the current count

#### Scenario: The divergence list names the new manifest directory

- **WHEN** `CLAUDE.md`'s "legitimate divergences" list is read
- **THEN** it SHALL include `.pi-plugin/` alongside `.claude-plugin/`, `.codex-plugin/`, `.hermes-plugin/`, and `.opencode-plugin/`

### Requirement: The shutdown reason decides whether the session is ended

`session_shutdown` is not a process-death signal. The harness declares `SessionShutdownEvent { type: "session_shutdown"; reason: "quit" | "reload" | "new" | "resume" | "fork"; targetSessionFile?: string }` (`dist/core/extensions/types.d.ts:462-468` of `@earendil-works/pi-coding-agent@0.84.1`), documented as "Fired before an extension runtime is torn down due to quit, reload, or session replacement", and four of the five reasons are session replacement inside a surviving process.

The extension SHALL issue the session end **only** when `reason` is a member of the explicit end-set `{quit, new, resume, fork}`. On `reload` it SHALL NOT end the session, because `reload` is the same session continuing. An end issued on a surviving session costs `session_id = NULL` on every later `memory.save` and `session_not_found` from `memory.session_summary` until the next `before_agent_start` ensure-and-resume repairs it, and there is no reason to incur a repairable fault when the correct branch is free. The existence of the resume path SHALL NOT be treated as making a wrong end cheap: within a single agent turn nothing re-runs `before_agent_start`, so the writes made between the wrong end and the next turn are lost to `session_id = NULL` and are not recoverable afterwards.

The extension SHALL NOT branch its resume on `reason`, `session_start`, or any other host signal; it SHALL issue exactly one `POST /api/<slug>/sessions/<id>/resume` after the FIRST `/sessions` ensure for that id in the process, which for this client is the shared core's registration entry point called from `before_agent_start` (`plugin-session-protocol`). Conditioning on a signal is not merely unnecessary here, it is unavailable: Pi's cold-start resume is reported as `reason: "startup"` on the `session_start` event — the harness substitutes `{ type: "session_start", reason: "startup" }` when no explicit event is supplied (`dist/core/agent-session.js:152` of `@earendil-works/pi-coding-agent@0.84.1`, reached from `dist/main.js:569-570` where the initial runtime passes `sessionStartEvent: undefined`) — so `pi -r`, `pi -c` and `pi --session <file>` are indistinguishable from a clean start, and `getEntries()` does not separate them either, since a persisted header-only session file yields zero entries exactly as a new session does.

The earlier prohibition on this mapping rested on a conflation that SHALL NOT be reintroduced: resuming on `startup` would revive "an unrelated terminal row" only if the row were selected by a heuristic. It is not. The resume names the id the ensure immediately before it named, and that id comes from the session file header Pi itself read (`SessionManager` sets `this.sessionId = header?.id ?? createSessionId()`, `dist/core/session-manager.js:632`), so the target is always the conversation the host is actually running. Pi's stable id is what makes this client the one where the whole loop is demonstrable end to end: `CLOSING_SHUTDOWN_REASONS` includes `quit`, so a quit genuinely ends the row, and the next `pi -r` of that conversation genuinely returns it to `active`.

The gate SHALL be expressed as membership in the end-set, NOT as an exclusion of `reload`. The two are equivalent for the five reasons that exist and diverge the moment the harness adds a sixth: exclusion would end on an unknown reason, membership does not. A `reason` that is absent, empty, or not a member of the end-set SHALL therefore NOT end the session. The extension's local type declaration for the event SHALL type `reason` as an optional string rather than the harness's five-member union, so the non-member branch remains reachable instead of being typed out of existence.

The extension SHALL additionally suppress the end when the shutdown is a replacement by the session it already holds. Resuming the currently-open session emits `reason: "resume"` and returns the SAME session id (`dist/core/session-manager.js:632`, `this.sessionId = header?.id ?? createSessionId()`, which reads the id from the resumed file's header), so the reason alone does not distinguish replacement-by-another from replacement-by-itself. The suppression SHALL compare `event.targetSessionFile` against `ctx.sessionManager.getSessionFile()` **only when `targetSessionFile` is a non-empty string**. A bare inequality comparison SHALL NOT be used: on `quit` the field is absent, so if `getSessionFile()` also returns `undefined` an unguarded comparison evaluates `undefined !== undefined` → false and suppresses the end on the most important reason.

`getSessionFile` SHALL be treated as optionally present, consistent with how the extension already treats the harness's `ui` channel: the extension is installed into whatever harness version the operator has. When the context does not expose it, the end SHALL proceed for every end-set reason — the same recoverable-versus-unrecoverable trade as above, resolved toward the failure a user can see.

Whichever branch runs, the extension SHALL still perform its awaited summary write and its MCP client close, and SHALL still forget the session's in-memory accumulator afterwards. No shutdown SHALL leave the accumulator unflushed and no shutdown SHALL leave a pending debounce timer alive.

#### Scenario: A closing reason ends the session

- **GIVEN** a registered Pi session with at least one accumulated turn
- **WHEN** `session_shutdown` fires with `reason` equal to `quit`, `new`, `resume` or `fork` and no `targetSessionFile` naming the current session file
- **THEN** the extension SHALL POST the session-end path for that session id
- **AND** the row SHALL have `status = 'ended'` with `ended_at` set

#### Scenario: `reload` does not end the session (the discriminating control)

- **GIVEN** a registered Pi session with at least one accumulated turn
- **WHEN** `session_shutdown` fires with `reason: "reload"`
- **THEN** the extension SHALL NOT POST the session-end path
- **AND** the row SHALL still have `status = 'active'` with `ended_at` unset
- **AND** the accumulated transcript SHALL still have been written, via the summary path

#### Scenario: Self-resume does not end the session

- **GIVEN** a registered Pi session whose session manager reports session file `F`
- **WHEN** `session_shutdown` fires with `reason: "resume"` and `targetSessionFile` equal to `F`
- **THEN** the extension SHALL NOT POST the session-end path
- **AND** the row SHALL still have `status = 'active'`

#### Scenario: An unrecognised reason does not end the session

- **WHEN** `session_shutdown` fires with `reason` absent, empty, or a value outside the end-set
- **THEN** the extension SHALL NOT POST the session-end path
- **AND** the row SHALL still have `status = 'active'`, left for the server's stale-active retirement sweep

#### Scenario: A quit-and-reopen round trip returns the row to active

- **GIVEN** a Pi session `<S>` with at least one accumulated turn, closed with `reason: "quit"` so its row is `ended`
- **WHEN** the operator reopens that persisted conversation (`pi -r`, `pi -c`, or `pi --session <file>`), the extension registers `<S>` on the first `before_agent_start` of the new process, and the resume follows
- **THEN** the row SHALL be `status='active'` with `ended_at IS NULL`
- **AND** a subsequent `memory.save` on that process's MCP transport SHALL persist `session_id = <S>`
- **AND** the control SHALL pass in the same run: without the resume the row stays `ended` and the same save persists `session_id = NULL`

#### Scenario: The resume fires once per process regardless of turn count

- **GIVEN** a reopened Pi session that runs N agent turns
- **WHEN** `before_agent_start` fires on each of them
- **THEN** exactly one `POST /api/<slug>/sessions/<id>/resume` SHALL have been issued across the whole process
- **AND** the count SHALL be independent of N and of the `session_start` event's `reason`

#### Scenario: The gate is covered by tests that fail without it

- **WHEN** the reason gate is widened to always-true and the test suite is re-run
- **THEN** the `reload` scenario's test SHALL fail
- **AND** when the `targetSessionFile` comparison is removed, the self-resume scenario's test SHALL fail

### Requirement: A Pi session row reaches `ended` on a real close, and `abandonStale` remains the only net for the rest

A Pi session that shuts down for an end-set reason SHALL leave its row in `status = 'ended'` with `ended_at` set, so no second `active` row survives for the same `(token, project)`. This is what removes the transport ambiguity: session resolution is "sole match or nothing" (`sessions` capability), so while a replaced Pi session stays `active` alongside its successor, the successor resolves to nothing and every implicit `memory.save` writes `session_id = NULL` for the whole staleness window.

The end SHALL be idempotent from the client's point of view: a second end on the same row returns success with the existing `ended_at` unchanged, and an end on a row the retirement sweep already flipped to `abandoned` SHALL leave it `abandoned` (see the `sessions` capability's terminal-write requirement). The extension SHALL NOT special-case either.

The following exits reach no handler and therefore end nothing; the row stays `active` until the server's stale-active retirement sweep flips it to `abandoned`. This SHALL be stated rather than implied, because a client that claims reliable termination it does not deliver is worse than one that claims none:

- `SIGKILL` and OS-level crashes.
- A single-press interrupt (the interrupt behaviour of this harness is described in this capability's session-close requirement and is not revisited here).
- Print mode receiving `SIGINT`, which it does not register as a signal.

No requirement in this capability SHALL assert that every Pi session reaches a terminal status.

#### Scenario: The successor session attributes its memories

- **GIVEN** a Pi session `A` registered for `(token, project)` and later replaced by session `B` on the same token and project
- **WHEN** `A`'s shutdown ended it and the agent then saves a memory from `B` without naming a `sessionId`
- **THEN** the saved row's `session_id` SHALL be `B`
- **AND** the count of memories attributed to `B` SHALL be non-zero

#### Scenario: The control — without the end, the successor attributes nothing

- **GIVEN** the same sequence with `A`'s shutdown NOT ending it, so `A` and `B` are both `active` within the staleness window
- **WHEN** the agent saves a memory from `B` without naming a `sessionId`
- **THEN** the saved row's `session_id` SHALL be `NULL`
- **AND** the count of memories attributed to `B` SHALL be zero

#### Scenario: A second end changes nothing

- **GIVEN** a Pi session row already `ended` with `ended_at = E`
- **WHEN** the end path is issued again for that row
- **THEN** the call SHALL succeed and `ended_at` SHALL still be `E`

#### Scenario: SIGKILL leaves the row for the sweep

- **GIVEN** a registered Pi session
- **WHEN** the process is SIGKILLed
- **THEN** no shutdown handler SHALL run and no end SHALL be issued
- **AND** the row SHALL remain `active` until the stale-active retirement sweep flips it to `abandoned`

### Requirement: Session close is awaited, and each exit path is named with the evidence for it

The harness awaits its session-shutdown handler without a timeout (measured against 0.84.1: a 300 ms awaited fetch completes, a 10 s one completes, and an MCP `tools/call` issued from inside the handler completes; SIGTERM and SIGHUP both reach it; the control — SIGKILL — runs nothing). This client SHALL therefore perform its final session flush as an **awaited** call and SHALL NOT use the fire-and-forget dispose flush the opencode client requires.

On a shutdown whose reason closes the session (see "The shutdown reason decides whether the session is ended"), that awaited call SHALL be **one** request: `POST /api/<slug>/sessions/<id>/end` with body `{summary, title, final:false}` built by the same summary-body builder the per-turn flush uses, or `{}` when that builder yields nothing because the transcript accumulator is empty. On a shutdown that does not close the session it SHALL remain the summary POST it is today.

The end SHALL NOT be split into a summary POST followed by an end POST. Because the handler is awaited, the risk this design manages is **exit latency**, not a dropped write: every POST is bounded by `POST_TIMEOUT_MS`, so two sequential POSTs double the worst case a quitting user waits on an unreachable server and exceed the teardown budget this capability's tests assert. One request also removes the question of what a half-completed pair means, and matches `apps/plugin/scripts/session-end.sh`, the one shutdown path in this repository with production mileage.

The end SHALL be the last write this client makes for that session. Precedence is asymmetric across the terminal boundary — active rows are last-final-wins, terminal rows are first-final-wins (see the `sessions` capability) — so a curated `memory.session_summary` arriving after an end is silently dropped. A client SHALL NOT end a session it may still write to.

The shared core SHALL expose both the awaited flush and the fire-and-forget variant so each client uses the one its host's shutdown semantics justify. Copying the fire-and-forget path into this client would discard a measured guarantee for symmetry alone and SHALL NOT be done.

**Two Ctrl-C presses within 500 ms DO close the session, and no surface SHALL state otherwise.** In the interactive TUI, with the prompt focused and on the default `app.clear` binding, `handleCtrlC()` calls the same `void this.shutdown()` that `handleCtrlD()` calls when `now - this.lastSigintTime < 500` (`dist/modes/interactive/interactive-mode.js:3048-3059`); `shutdown()` awaits `runtimeHost.dispose()` before `process.exit(0)` (`:3100`). The emitted reason is `quit`, already in this client's end-set, so the session ends correctly with no code change. Pi advertises the key itself in its startup banner (`:667`, `${keyText("app.clear")} twice` "to exit").

Measured against 0.84.1 under `script -q` with timed stdin, `HOME` redirected and no server running, recording `Date.now()-t0` on `session_shutdown`:

| Arm                                        | `session_shutdown` fired at | Reason |
| ------------------------------------------ | --------------------------- | ------ |
| No keys at all (baseline — stdin EOF only) | 10577 ms                    | `quit` |
| Two Ctrl-C 200 ms apart                    | **5809 ms**                 | `quit` |
| Two Ctrl-C 1500 ms apart                   | 11839 ms                    | `quit` |

The 200 ms arm fires ~4.8 s before anything the baseline can produce, so only the key explains it; 11839 − 10577 ≈ the 1300 ms of extra key spacing, which is the table checking itself. **`reason` cannot discriminate and never could** — every arm reports `quit`, because the EOF exit and the key exit both terminate through `runtimeHost.dispose()` — so a probe asserting the reason, or merely that the handler ran, passes on the baseline too. Only elapsed time discriminates, and any future re-measurement SHALL be timed against a no-keys baseline.

All three qualifiers above are load-bearing and SHALL be carried wherever this is documented: **twice within 500 ms** (`:3048`'s guard), **in the interactive TUI with the prompt focused** (the handler binds to the default editor, `:2223`; an overlay routes the key elsewhere and is unmeasured), and **on the default binding** (`dist/core/keybindings.js:8`, user-rebindable).

**The exits that reach no handler, each stated with its evidence grade:**

- **A single Ctrl-C press, or two spaced beyond the window** (measured): the 1500 ms arm above lands at the stdin EOF, so the key contributed nothing. A single press clears the editor and arms the window; it SHALL NOT be documented as exiting.
- **Print-mode SIGINT** (**source read, not executed**): `dist/modes/print-mode.js:32-44` registers `["SIGTERM"]` plus SIGHUP, and `SIGINT` appears nowhere in that file. This claim is labelled rather than presented as measured, because three attempts to execute it failed their control arm and were discarded — inside a requirement whose interactive half was overturned by a run, an unexecuted read SHALL NOT be presented as a measurement.
- **SIGKILL and OS-level crashes** (measured — the discriminating control below).

For those paths the per-turn flush bounds the **summary** loss at one turn. It bounds nothing about `status`: a process that reaches no handler leaves its row `active` until the server's stale-active sweep retires it as `abandoned`, and no flush changes that.

#### Scenario: Shutdown flush completes

- **GIVEN** a session with accumulated transcript entries
- **WHEN** the harness shuts the session down via its normal exit path or SIGTERM
- **THEN** the summary POST SHALL complete before the process exits
- **AND** the server SHALL hold a non-null summary for that session

#### Scenario: The closing shutdown issues exactly one request

- **GIVEN** a session with accumulated transcript entries
- **WHEN** the harness shuts the session down with a reason in the end-set
- **THEN** the extension SHALL issue exactly one session-write request, to the end path, carrying the accumulated summary and derived title with `final:false`
- **AND** it SHALL NOT also issue a request to the summary path for that session

#### Scenario: An empty transcript still ends the session

- **GIVEN** a registered session whose transcript accumulator is empty
- **WHEN** the harness shuts the session down with a reason in the end-set
- **THEN** the extension SHALL POST the end path with an empty JSON body
- **AND** the row SHALL have `status = 'ended'` with `summary` still null

#### Scenario: The teardown budget holds against an unreachable server

- **GIVEN** a server that accepts connections and never answers
- **WHEN** the harness shuts the session down with `reason: "quit"`
- **THEN** the elapsed teardown SHALL stay within the budget this capability's test asserts, measured as the end-to-end handler wall-clock rather than the timing of the request in isolation

#### Scenario: SIGKILL runs nothing (the discriminating control)

- **WHEN** the process receives SIGKILL
- **THEN** no shutdown handler SHALL run and no summary POST SHALL be issued

#### Scenario: The interrupt is documented by what was measured, not by mode

- **WHEN** the extension's README, the client documentation, or the plugin-development skill describes session capture or how to exit
- **THEN** it SHALL state that in the interactive TUI two Ctrl-C presses within 500 ms run the same awaited shutdown that Ctrl-D runs, so the session is closed and nothing beyond the current turn is at risk
- **AND** it SHALL carry all three qualifiers — twice within 500 ms, interactive TUI with the prompt focused, default binding
- **AND** it SHALL NOT state that a single Ctrl-C press exits, nor that an interrupt fails to close the session in the interactive TUI
- **AND** where it names print-mode SIGINT it SHALL attribute that to Pi's source rather than to a measurement

#### Scenario: No operator surface attributes a lost turn to an interactive Ctrl-C

- **WHEN** a troubleshooting entry explains a session whose last turn is missing, or a session row with no summary
- **THEN** the cause it names SHALL be one of the exits measured or read to reach no handler — SIGKILL, an OS-level crash, or an interrupted print-mode run
- **AND** it SHALL NOT name a Ctrl-C in the interactive TUI as the cause
- **AND** it SHALL NOT name a cause for which this capability records no evidence
