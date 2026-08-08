## ADDED Requirements

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

`apps/plugin/.pi-plugin/index.ts` SHALL obtain the nudge strings, `stripPrivateTags`, the truncation helpers, the stderr diagnostic, the session HTTP client, the transcript accumulator, the summary-body builder and the flush helpers from `apps/plugin/bin/rembric-plugin-core.mjs`. It SHALL NOT declare its own copy of any of them.

The core module SHALL require `agent` as a mandatory parameter of session registration, with **no default value**. `sessions.agent` is written once per session and memory is append-only, so a defaulted value registers sessions under the wrong agent permanently, with no repair verb. The hand-written type declaration `apps/plugin/bin/rembric-plugin-core.d.mts` SHALL declare `agent` as a required property so an omission is a compile error in the TypeScript clients.

#### Scenario: The extension imports the core rather than copying it

- **WHEN** `apps/plugin/.pi-plugin/index.ts` is read at HEAD
- **THEN** it contains an import statement referencing `rembric-plugin-core.mjs`
- **AND** it declares no local `function stripPrivateTags`, no local nudge string constant, and no local session-POST helper

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

### Requirement: Session close is awaited, with the interrupt exception recorded

The harness awaits its session-shutdown handler without a timeout (measured against 0.84.1: a 300 ms awaited fetch completes, a 10 s one completes, and an MCP `tools/call` issued from inside the handler completes; SIGTERM and SIGHUP both reach it; the control — SIGKILL — runs nothing). This client SHALL therefore perform its final session flush as an **awaited** call and SHALL NOT use the fire-and-forget dispose flush the opencode client requires.

The shared core SHALL expose both the awaited flush and the fire-and-forget variant so each client uses the one its host's shutdown semantics justify. Copying the fire-and-forget path into this client would discard a measured guarantee for symmetry alone and SHALL NOT be done.

**Known edge, recorded rather than assumed benign:** SIGINT does **not** trigger the shutdown handler in print mode — `dist/modes/print-mode.js:32` reads `const signals = ["SIGTERM"]`, with SIGHUP wired separately — so a Ctrl-C in print mode loses the session close. The interactive TUI behaves the same way, and this was measured rather than inferred: driving a real TUI under a pty with keys delivered at t=4 s and stdin held open until t=14 s, Ctrl-C left the shutdown handler running at **13.6 s** (i.e. the stdin EOF fired it, not the key), byte-identical to the no-keys control, while Ctrl-D fired it at **3.6 s**. The Ctrl-D arm proves the byte channel worked, so the interrupt byte arrived and was simply not treated as an exit. A first version of this probe reported Ctrl-C as working; it was an instrument artefact, because closing stdin ended the session regardless — the control that must fail is what exposed it.

Therefore: **Ctrl-C is not a reliable session-close path in either mode**; Ctrl-D, SIGTERM and SIGHUP are, and all three are awaited. The per-turn flush bounds the loss at one turn.

#### Scenario: Shutdown flush completes

- **GIVEN** a session with accumulated transcript entries
- **WHEN** the harness shuts the session down via its normal exit path or SIGTERM
- **THEN** the summary POST SHALL complete before the process exits
- **AND** the server SHALL hold a non-null summary for that session

#### Scenario: SIGKILL runs nothing (the discriminating control)

- **WHEN** the process receives SIGKILL
- **THEN** no shutdown handler SHALL run and no summary POST SHALL be issued

#### Scenario: Ctrl-C is documented as lossy in both modes

- **WHEN** the extension's README or the client documentation describes session capture
- **THEN** it SHALL state that a Ctrl-C does not trigger the session close in either print or interactive mode, that Ctrl-D does, and that the per-turn flush bounds the loss to one turn

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

Pi SHALL NOT be a release-please component of its own, SHALL NOT have its own tag line, and SHALL NOT carry an independent npm version. `.release-please-manifest.json` SHALL continue to declare exactly two entries. The directory SHALL sit inside the component's `path` because release-please attributes a release to a component by the paths of the commits under that `path` — so a Pi-only commit SHALL trigger a `plugin` release exactly as a commit to any other client does. A carrier placed outside `apps/plugin/` would still be *writable* by release-please (a leading-slash `extra-files` path resolves against the repository root), but would never *cause* a release, so the lock-step guarantee would be lost.

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
