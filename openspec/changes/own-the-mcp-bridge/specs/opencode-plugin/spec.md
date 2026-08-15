## RENAMED Requirements

- FROM: `### Requirement: MCP transport reuses the existing stdio bridge`
- TO: `### Requirement: MCP transport spawns the published bridge, with a launcher for existing installs`

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

### Requirement: MCP transport spawns the published bridge, with a launcher for existing installs

**Normative supersession.** This requirement retains the published launcher and
path scenarios below so the MODIFIED delta remains traceable. Those historical
scenario blocks are non-normative after this notice: every launcher, copied
`apps/plugin/bin/` bridge, and `node <path>` result they contain is superseded
by the current contract below. Existing user-owned launcher files are handled
by the in-memory config hook; this repository neither ships nor maintains one.

New and existing opencode configurations SHALL use the published bridge. When
`mcp.rembric` exists, the plugin's `config` hook SHALL replace only its
in-memory `command` with `['npx', '-y', '@rembric/mcp-bridge@<plugin version>']`.
It SHALL preserve the environment, enabled state, and unrelated entries, and
SHALL never write `opencode.json`. When the entry is absent, the hook SHALL
leave the configuration unchanged.

The MCP server entry printed for a fresh install SHALL be:

```json
{
  "mcp": {
    "rembric": {
      "type": "local",
      "command": ["npx", "-y", "@rembric/mcp-bridge@<x.y.z>"],
      "environment": {
        "REMBRIC_SERVER_URL": "<URL>",
        "REMBRIC_API_TOKEN": "<TOKEN>"
      },
      "enabled": true
    }
  }
}
```

`<x.y.z>` SHALL be an exact pin equal to `apps/plugin/package.json::version`.
The command SHALL contain no URL, header, or `--allow-http` argument. The
installer SHALL print this snippet, SHALL NOT write `opencode.json`, and SHALL
not copy or remove a legacy launcher. It SHALL fetch the moved dotenv module
from `apps/plugin/mcp-bridge/` and `rembric-plugin-core.mjs` from
`apps/plugin/bin/`; local iteration SHALL support `MCP_BRIDGE_SRC` alongside
`PLUGIN_SRC` and `BIN_SRC`. The plugin SHALL NOT register its own MCP server
programmatically or use `type: "remote"`.

#### Scenario: Bridge file is reused without divergence

The published scenario is retained for MODIFIED-body provenance; its launcher
path assertions are superseded by the current contract above.

- **WHEN** the repository is at HEAD
- **THEN** `apps/plugin/.opencode-plugin/` contains no `*.mjs` or `*-bridge.*` file
- **AND** the install script copies `apps/plugin/bin/rembric-bridge.mjs` (not a sibling copy) to the user's `~/.config/rembric/bin/`
- **AND** no opencode-specific variant of the bridge SHALL exist

#### Scenario: MCP snippet uses type: local with the shared bridge path

The published scenario is retained for MODIFIED-body provenance; its launcher
command and path assertions are superseded by the fresh-install snippet above.

- **WHEN** the install script runs and prints the MCP snippet
- **THEN** the printed JSON has `mcp.rembric.type = "local"`
- **AND** `mcp.rembric.command` is `["npx", "-y", "@rembric/mcp-bridge@<x.y.z>"]` at an exact pinned version — the title's "shared bridge path" describes the form this change replaces, and is kept because a published scenario title cannot be renamed inside a MODIFIED block
- **AND** `mcp.rembric.environment` declares exactly `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` as placeholder values for the user to edit
- **AND** the snippet SHALL NOT name any path under `${HOME}/.config/rembric/bin/`

#### Scenario: Default install URLs point at apps/plugin

The published scenario is retained for MODIFIED-body provenance. Its bridge
carrier is superseded; the moved dotenv path remains current.

- **WHEN** a user runs `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.opencode-plugin/install.sh | sh`
- **THEN** the script SHALL fetch `plugin.ts` from `.../apps/plugin/.opencode-plugin/plugin.ts`
- **AND** the script SHALL fetch `rembric-bridge.mjs` from `.../apps/plugin/bin/rembric-bridge.mjs`
- **AND** the script SHALL fetch `rembric-dotenv.mjs` from `.../apps/plugin/mcp-bridge/rembric-dotenv.mjs`
- **AND** none of the URLs SHALL contain the legacy `/plugin/` path

#### Scenario: Legacy install URL returns 404

The published scenario is retained unchanged; it remains current.

- **WHEN** a user runs `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.opencode-plugin/install.sh | sh`
- **THEN** `curl -fsSL` SHALL fail with a 404 from `raw.githubusercontent.com` and exit non-zero — no shim file is kept under `plugin/`
- **AND** no files SHALL be installed under `~/.config/opencode/` or `~/.config/rembric/bin/`
- **AND** the corrected install command SHALL be discoverable in `README.md`, `docs/agents.md`, `apps/plugin/.opencode-plugin/README.md`, and the first post-restructure `opencode-plugin-vX.Y.Z` release notes

#### Scenario: An existing install keeps working through the launcher

The published launcher scenario is retained for MODIFIED-body provenance but is
superseded: the config hook upgrades the command in memory and the repository
does not maintain the launcher.

- **GIVEN** an `opencode.json` written before this change, naming `<HOME>/.config/rembric/bin/rembric-bridge.mjs`
- **WHEN** the user re-runs the install script and then starts opencode
- **THEN** the launcher at that path SHALL spawn the pinned bridge
- **AND** the session SHALL connect and list tools exactly as a new install does

#### Scenario: The launcher carries no logic of its own

The published launcher scenario is retained for MODIFIED-body provenance but is
superseded because the launcher is deleted from the repository.

- **WHEN** `apps/plugin/bin/rembric-bridge.mjs` is read at HEAD
- **THEN** it SHALL contain no `.rembric` read, no URL construction, no `/healthz` request, and no slug regex
- **AND** its only outbound behaviour SHALL be spawning the pinned bridge with the inherited environment

#### Scenario: The launcher pins an exact version like every other spawn site

The published launcher scenario is retained for MODIFIED-body provenance but is
superseded because there is no launcher carrier.

- **WHEN** the launcher is read
- **THEN** its package specifier SHALL name an exact `@rembric/mcp-bridge@<x.y.z>` version
- **AND** that version SHALL equal `apps/plugin/package.json::version`

#### Scenario: Existing launcher configuration is upgraded in memory

- **GIVEN** `mcp.rembric.command` names `node` and a legacy `rembric-bridge.mjs` path
- **WHEN** opencode invokes the plugin's `config` hook
- **THEN** the in-memory command SHALL be `['npx', '-y', '@rembric/mcp-bridge@<plugin version>']`
- **AND** the environment and all unrelated config values SHALL be unchanged
- **AND** `opencode.json` SHALL not be written

#### Scenario: An absent MCP entry is not invented

- **GIVEN** a config with no `mcp.rembric` entry
- **WHEN** the config hook runs
- **THEN** the config SHALL remain unchanged
- **AND** the installer SHALL print the exact pinned snippet for the user to paste

#### Scenario: The hook pin is exact

- **WHEN** the config hook is run at a plugin version
- **THEN** its command SHALL contain exactly `@rembric/mcp-bridge@<plugin version>`
- **AND** it SHALL contain no URL, `--header`, or `--allow-http` argument

#### Scenario: The bridge package is used without a sibling implementation

- **WHEN** the repository is at HEAD
- **THEN** `apps/plugin/.opencode-plugin/` SHALL contain no bridge implementation
- **AND** the plugin SHALL use the published `@rembric/mcp-bridge` package

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
