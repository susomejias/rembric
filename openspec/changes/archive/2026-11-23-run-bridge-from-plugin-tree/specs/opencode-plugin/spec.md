## ADDED Requirements

### Requirement: MCP transport spawns the downloaded bridge through the config hook

The plugin's `config` hook SHALL configure `mcp.rembric` in memory with `type: "local"`, `command: ['node', '<home>/.config/rembric/bin/cli.mjs']`, the environment references `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN`, and `enabled: true`, where `<home>` is the user's home directory as an absolute path. It SHALL do so only when `<home>/.config/rembric/bin/cli.mjs` exists. When that file exists and an entry already exists, the hook SHALL replace only its in-memory command and preserve its other values and unrelated entries; this covers a legacy `node` command naming `rembric-bridge.mjs` and a pinned `npx` command naming `@rembric/mcp-bridge`. When that file exists and no entry exists, the hook SHALL add this default entry in memory. The hook SHALL never write `opencode.json`.

When `<home>/.config/rembric/bin/cli.mjs` does not exist, the hook SHALL leave an existing `mcp.rembric` entry, its command included, unchanged, SHALL NOT create an entry, and SHALL log one line telling the operator to re-run the Rembric installer. An installation whose bridge files were never downloaded therefore keeps the command it already had.

The command SHALL contain no URL, header, `--allow-http` argument, package specifier or version. The plugin SHALL carry no bridge version constant. The installer SHALL explain that the hook owns the in-memory entry, SHALL NOT write `opencode.json`, and SHALL not copy or remove a legacy launcher. It SHALL fetch the bridge files, including the moved dotenv module, from `apps/plugin/mcp-bridge/` and `rembric-plugin-core.mjs` from `apps/plugin/bin/`; local iteration SHALL support `MCP_BRIDGE_SRC` alongside `PLUGIN_SRC` and `BIN_SRC`. The plugin SHALL NOT use `type: "remote"` for its Rembric entry.

#### Scenario: Existing launcher configuration is upgraded in memory when the bridge is present

- **GIVEN** `mcp.rembric.command` names `node` and a legacy `rembric-bridge.mjs` path
- **AND** `<home>/.config/rembric/bin/cli.mjs` exists
- **WHEN** opencode invokes the plugin's `config` hook
- **THEN** the in-memory command SHALL be `['node', '<home>/.config/rembric/bin/cli.mjs']`
- **AND** the environment and all unrelated config values SHALL be unchanged
- **AND** `opencode.json` SHALL not be written

#### Scenario: A pinned npx command is upgraded in memory when the bridge is present

- **GIVEN** `mcp.rembric.command` is `['npx', '-y', '@rembric/mcp-bridge@<x.y.z>']`
- **AND** `<home>/.config/rembric/bin/cli.mjs` exists
- **WHEN** the config hook runs
- **THEN** the in-memory command SHALL be `['node', '<home>/.config/rembric/bin/cli.mjs']`
- **AND** the environment and all unrelated config values SHALL be unchanged
- **AND** `opencode.json` SHALL not be written

#### Scenario: An absent MCP entry is added only in memory when the bridge is present

- **GIVEN** a config with no `mcp.rembric` entry
- **AND** `<home>/.config/rembric/bin/cli.mjs` exists
- **WHEN** the config hook runs
- **THEN** it SHALL add an in-memory local entry using the `node` command and the two credential environment placeholders
- **AND** `opencode.json` SHALL not be written

#### Scenario: A missing bridge leaves an existing command untouched

- **GIVEN** `mcp.rembric.command` is `['npx', '-y', '@rembric/mcp-bridge@<x.y.z>']`
- **AND** `<home>/.config/rembric/bin/cli.mjs` does not exist
- **WHEN** the config hook runs
- **THEN** the in-memory entry, its command included, SHALL be unchanged
- **AND** the hook SHALL log one line telling the operator to re-run the Rembric installer
- **AND** `opencode.json` SHALL not be written

#### Scenario: A missing bridge creates no entry

- **GIVEN** a config with no `mcp.rembric` entry
- **AND** `<home>/.config/rembric/bin/cli.mjs` does not exist
- **WHEN** the config hook runs
- **THEN** the config SHALL still have no `mcp.rembric` entry
- **AND** the hook SHALL log one line telling the operator to re-run the Rembric installer

#### Scenario: The hook command names only the downloaded bridge

- **WHEN** the config hook sets the command
- **THEN** the command SHALL be exactly `node` followed by the absolute path of `<home>/.config/rembric/bin/cli.mjs`
- **AND** it SHALL contain no `npx`, package specifier, version, URL, `--header`, or `--allow-http` argument

#### Scenario: The bridge files are used without a sibling implementation

- **WHEN** the plugin tree is inspected
- **THEN** no opencode-specific stdio-to-HTTP bridge implementation or maintained launcher SHALL exist
- **AND** the config hook SHALL spawn the bridge files the installer downloads from `apps/plugin/mcp-bridge/`

## MODIFIED Requirements

### Requirement: Shared dotenv lib SHALL be the single source of truth for slug parsing

The repository SHALL contain a shared dotenv module exporting exactly: `parseDotenv(content: string)`, `readRembricSlug(directory: string)`, and `SLUG_RE`. This module SHALL be the only place where the slug regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` and the dotenv parser live in JS/TS form across the entire repository.

Its canonical location SHALL be `apps/plugin/mcp-bridge/rembric-dotenv.mjs`. It moved there from `apps/plugin/bin/` because slug resolution became the bridge's job, so the module must ship inside the bridge's published tarball and sit among the bridge files under `apps/plugin/mcp-bridge/` that the plugins run and the installer downloads; the property that matters — **exactly one** JS/TS implementation — is unchanged, only its address is. A copy left behind at the old path would be the second implementation this requirement exists to forbid.

`apps/plugin/.opencode-plugin/plugin.ts` and `apps/plugin/.pi-plugin/index.ts` SHALL import `readRembricSlug` from `../mcp-bridge/rembric-dotenv.mjs`. The bridge SHALL import `parseDotenv` and `SLUG_RE` from `./rembric-dotenv.mjs`. No client file SHALL define its own copy of these helpers.

Bash (`apps/plugin/scripts/_api.sh::rembric_parse_dotenv` and `::rembric_read_project_slug`) and Python (`apps/plugin/.hermes-plugin/__init__.py::_SLUG_RE`) clients keep their own implementations because cross-language wrapping a 20-line parser costs more than the duplication. Those implementations MUST agree on the regex.

An invariant test in `apps/web/src/test/invariants.test.ts` SHALL fail the build if any JS/TS file under `apps/plugin/` declares its own `parseDotenv` function or `SLUG_RE` constant. The scanned set SHALL be every JS/TS source file under `apps/plugin/` — not only client files — so a non-client artefact such as the bridge is covered by contract rather than by the incidental reach of a glob. The invariant test SHALL reference the canonical path in its assertions, and moving the module SHALL therefore require updating that reference in the same change.

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
- **WHEN** `pnpm vitest run apps/web/src/test/invariants.test.ts` runs
- **THEN** the test FAILS with a message naming the offending file

#### Scenario: The invariant scans a derived, non-empty file list

- **WHEN** the invariant runs
- **THEN** its scanned-file list SHALL be derived from a repository-wide search over `apps/plugin/`
- **AND** the test SHALL fail if that list is empty, before evaluating any negative assertion

### Requirement: Install script contract

`apps/plugin/.opencode-plugin/install.sh` SHALL follow the current install contract, which supersedes the copied-launcher details retained in
its historical scenarios below. It SHALL remain a POSIX `sh` script with `set -eu`; copy the plugin, the
bridge files, and `rembric-plugin-core.mjs`; verify every rewritten
shared import; print rather than write the MCP snippet; and never create,
modify, or delete `opencode.json`.

It SHALL fetch `rembric-dotenv.mjs`, `rembric-project.mjs`, `cli.mjs`,
`bridge.mjs`, `slug.mjs` and `rembric-host-binding.mjs` from
`apps/plugin/mcp-bridge/` and
`rembric-plugin-core.mjs` from `apps/plugin/bin/` into
`~/.config/rembric/bin/`, from the same source and ref as the plugin file. The
printed command SHALL be `['node', '<absolute path>/cli.mjs']`, where the
absolute path is `~/.config/rembric/bin/` with `$HOME` expanded, with literal
URL and token placeholders. It SHALL not copy or remove the deleted repository
launcher; existing user-owned launcher files are handled by the config hook.
The moved dotenv source is required and its absence SHALL fail loudly.

Each of `cli.mjs`, `bridge.mjs`, `slug.mjs` and `rembric-host-binding.mjs` SHALL
be required, SHALL be written to a temporary name in `~/.config/rembric/bin/`
and SHALL be renamed into place only after its download completes. `cli.mjs`
SHALL be renamed into place last, so a present `cli.mjs` implies the modules it
imports are present. A failed download SHALL exit non-zero naming the file,
SHALL leave no temporary file behind, and SHALL leave a `cli.mjs` from a
previous install unchanged.

#### Scenario: Idempotent re-run

The published scenario remains current for the shared files and installer
state; the launcher copy it formerly implied is superseded.

- **WHEN** `install.sh` runs twice in succession
- **THEN** both invocations exit 0
- **AND** every destination file exists after each invocation, including `rembric-plugin-core.mjs`
- **AND** their contents match the source files

#### Scenario: Snippet has expanded $HOME but unexpanded placeholders

- **GIVEN** `$HOME = /Users/alice`
- **WHEN** the install script prints the MCP snippet
- **THEN** the snippet's `command` SHALL be `['node', '/Users/alice/.config/rembric/bin/cli.mjs']` and SHALL contain no `npx` or `@rembric/mcp-bridge`
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
- **AND** stdout SHALL contain the exact `node` MCP snippet

#### Scenario: An existing opencode.json is byte-identical

- **WHEN** the installer runs with an existing `opencode.json`
- **THEN** its bytes SHALL be unchanged
- **AND** stdout SHALL contain the snippet for manual paste

#### Scenario: Missing bridge source aborts

- **GIVEN** `apps/plugin/mcp-bridge/rembric-dotenv.mjs` is absent
- **WHEN** `install.sh` runs
- **THEN** the script SHALL exit non-zero
- **AND** writes a stderr message naming `apps/plugin/mcp-bridge/rembric-dotenv.mjs`

#### Scenario: Bridge files are installed beside the shared libraries

- **WHEN** `install.sh` completes
- **THEN** `~/.config/rembric/bin/` SHALL contain `cli.mjs`, `bridge.mjs`, `slug.mjs`, `rembric-host-binding.mjs`, `rembric-project.mjs`, `rembric-dotenv.mjs` and `rembric-plugin-core.mjs`
- **AND** each SHALL match its source file byte for byte
- **AND** no temporary download file SHALL remain in `~/.config/rembric/bin/`

#### Scenario: An interrupted bridge download leaves no partial bridge

- **GIVEN** fetching one of `cli.mjs`, `bridge.mjs`, `slug.mjs` or `rembric-host-binding.mjs` fails
- **WHEN** `install.sh` runs
- **THEN** the script SHALL exit non-zero naming the file that failed
- **AND** no temporary download file SHALL remain in `~/.config/rembric/bin/`
- **AND** a `cli.mjs` that existed before the run SHALL be unchanged, and none SHALL be created where none existed

### Requirement: Uninstall script contract

`apps/plugin/.opencode-plugin/uninstall.sh` SHALL:

1. Use `#!/usr/bin/env bash` shebang and `set -uo pipefail` (no `-e` — we want to continue past missing files).
2. Remove `${HOME}/.config/opencode/plugins/rembric.ts` if present.
3. Remove `${HOME}/.config/rembric/bin/rembric-bridge.mjs` if present.
4. Remove `${HOME}/.config/rembric/bin/rembric-dotenv.mjs` if present (the shared dotenv lib copied by `install.sh`), unless item 6 keeps it.
5. Remove `${HOME}/.config/rembric/bin/rembric-plugin-core.mjs` if present (the shared session-protocol core copied by `install.sh`).
6. Remove `cli.mjs`, `bridge.mjs`, `slug.mjs` and `rembric-host-binding.mjs` from `${HOME}/.config/rembric/bin/` if present, only when `${HERMES_HOME:-~/.hermes}/config.yaml` is absent or contains neither `${HOME}/.config/rembric/bin/cli.mjs` nor `~/.config/rembric/bin/cli.mjs`. When it contains either, those four files, `rembric-dotenv.mjs` and `rembric-project.mjs` SHALL be kept, because Hermes's MCP entry runs them.
7. Remove `${HOME}/.config/rembric/bin/` if empty.
8. Remove `${HOME}/.config/rembric/` if empty.
9. Print a final banner listing what was removed and what was NOT removed (e.g., the MCP block in `opencode.json`, which the user must edit manually, and bridge files kept for Hermes).
10. Exit 0 even if all targets were absent (idempotent).

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

#### Scenario: Bridge files are kept while Hermes runs them

- **GIVEN** `${HERMES_HOME:-~/.hermes}/config.yaml` contains `${HOME}/.config/rembric/bin/cli.mjs`
- **WHEN** `uninstall.sh` runs
- **THEN** `${HOME}/.config/opencode/plugins/rembric.ts` and `rembric-plugin-core.mjs` SHALL be removed
- **AND** `cli.mjs`, `bridge.mjs`, `slug.mjs`, `rembric-host-binding.mjs`, `rembric-dotenv.mjs` and `rembric-project.mjs` SHALL remain byte-identical in `${HOME}/.config/rembric/bin/`
- **AND** the banner SHALL name them as kept for Hermes

#### Scenario: Bridge files are removed when Hermes does not run them

- **GIVEN** `${HERMES_HOME:-~/.hermes}/config.yaml` is absent or does not reference `cli.mjs` under `~/.config/rembric/bin/`
- **WHEN** `uninstall.sh` runs
- **THEN** `cli.mjs`, `bridge.mjs`, `slug.mjs` and `rembric-host-binding.mjs` SHALL be removed from `${HOME}/.config/rembric/bin/`
- **AND** the script SHALL exit 0

## REMOVED Requirements

### Requirement: MCP transport spawns the published bridge through the config hook

**Reason**: The hook spawned `npx -y @rembric/mcp-bridge@<plugin version>`, so the MCP server could not start until the npm publish of that version, which lagged the plugin release, had completed. The hook now runs the bridge the installer placed from the same ref as the plugin.

**Migration**: Replaced by the ADDED requirement for the downloaded bridge. The hook switches to `node <home>/.config/rembric/bin/cli.mjs` only when that file exists; an existing `npx` or legacy command keeps working until the installer has placed the bridge files.
