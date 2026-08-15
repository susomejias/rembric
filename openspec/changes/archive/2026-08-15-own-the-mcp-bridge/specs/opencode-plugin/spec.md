## RENAMED Requirements

- FROM: `### Requirement: MCP transport reuses the existing stdio bridge`
- TO: `### Requirement: MCP transport spawns the published bridge through the config hook`

## MODIFIED Requirements

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
- **THEN** `apps/plugin/mcp-bridge/rembric-dotenv.mjs` exists and `apps/plugin/bin/rembric-dotenv.mjs` does not
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

#### Scenario: Missing bridge source aborts

The old source-path scenario is retained for provenance but superseded by the
package's published bridge source and the hook-based compatibility path.

- **GIVEN** `apps/plugin/bin/rembric-bridge.mjs` is absent
- **WHEN** `install.sh` runs
- **THEN** the script exits with a non-zero code
- **AND** writes a stderr message naming the missing path

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
