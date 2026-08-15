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

New opencode installs SHALL reach the server by spawning the published bridge directly. The bridge SHALL NOT be forked, copied with modifications, or replaced by an opencode-specific variant.

The MCP server entry in the user's `opencode.json` SHALL be:

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

where `<x.y.z>` is an exact pinned version, never a floating tag. The install script SHALL leave `<URL>` and `<TOKEN>` as placeholders (or as `{env:REMBRIC_*}` substitutions per the install.sh auto-config branch) for the user.

The install script SHALL fetch the launcher from `https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/bin/rembric-bridge.mjs` (and `rembric-plugin-core.mjs` from the same `apps/plugin/bin/` prefix, and the companion `rembric-dotenv.mjs` from `apps/plugin/mcp-bridge/`) when running against the public repo. Local-dev iteration via `PLUGIN_SRC` + `BIN_SRC` env vars SHALL continue to work, with the dev paths pointing at `apps/plugin/.opencode-plugin/`, `apps/plugin/bin/` and `apps/plugin/mcp-bridge/` respectively.

The plugin SHALL NOT register its own MCP server programmatically and SHALL NOT use `type: "remote"`.

**`apps/plugin/bin/rembric-bridge.mjs` SHALL survive as a deprecated on-disk launcher, and this capability is its only consumer.** The reason is specific and does not generalise: `~/.config/opencode/opencode.json` is written **once**, by the user, from the snippet the installer prints — the install script SHALL NOT touch that file — so an existing install keeps naming `<HOME>/.config/rembric/bin/rembric-bridge.mjs` indefinitely. Deleting that file would break every existing opencode install with an error the user cannot interpret. Claude Code and Codex need no launcher, because their manifests ship inside the plugin tree and are replaced on update.

The launcher's entire contract:

- It SHALL spawn `npx -y @rembric/mcp-bridge@<x.y.z>` at an exact pinned version, inherit stdio, and pass its environment through unchanged.
- It SHALL forward the child's exit code, and re-raise a terminating signal in its own process.
- It SHALL contain **no other logic**: no `.rembric` parsing, no URL building, no `/healthz` check, no diagnostics beyond a spawn failure. Every one of those now belongs to the bridge, and a second implementation in the launcher would be exactly the duplication this tree forbids.
- Its pinned version SHALL be a release-please carrier, like every other spawn site.

The launcher is deprecated on arrival: its population only shrinks, since new installs never receive it. Its removal is a separate future change, gated on a way to know existing `opencode.json` files have turned over.

#### Scenario: Bridge file is reused without divergence

- **WHEN** the repository is at HEAD
- **THEN** `apps/plugin/.opencode-plugin/` contains no `*.mjs` or `*-bridge.*` file
- **AND** the install script copies `apps/plugin/bin/rembric-bridge.mjs` (not a sibling copy) to the user's `~/.config/rembric/bin/`
- **AND** no opencode-specific variant of the bridge SHALL exist

#### Scenario: MCP snippet uses type: local with the shared bridge path

- **WHEN** the install script runs and prints the MCP snippet
- **THEN** the printed JSON has `mcp.rembric.type = "local"`
- **AND** `mcp.rembric.command` is `["npx", "-y", "@rembric/mcp-bridge@<x.y.z>"]` at an exact pinned version — the title's "shared bridge path" describes the form this change replaces, and is kept because a published scenario title cannot be renamed inside a MODIFIED block
- **AND** `mcp.rembric.environment` declares exactly `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` as placeholder values for the user to edit
- **AND** the snippet SHALL NOT name any path under `${HOME}/.config/rembric/bin/`

#### Scenario: Default install URLs point at apps/plugin

- **WHEN** a user runs `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.opencode-plugin/install.sh | sh`
- **THEN** the script SHALL fetch `plugin.ts` from `.../apps/plugin/.opencode-plugin/plugin.ts`
- **AND** the script SHALL fetch `rembric-bridge.mjs` from `.../apps/plugin/bin/rembric-bridge.mjs`
- **AND** the script SHALL fetch `rembric-dotenv.mjs` from `.../apps/plugin/mcp-bridge/rembric-dotenv.mjs`
- **AND** none of the URLs SHALL contain the legacy `/plugin/` path

#### Scenario: Legacy install URL returns 404

- **WHEN** a user runs `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.opencode-plugin/install.sh | sh`
- **THEN** `curl -fsSL` SHALL fail with a 404 from `raw.githubusercontent.com` and exit non-zero — no shim file is kept under `plugin/`
- **AND** no files SHALL be installed under `~/.config/opencode/` or `~/.config/rembric/bin/`
- **AND** the corrected install command SHALL be discoverable in `README.md`, `docs/agents.md`, `apps/plugin/.opencode-plugin/README.md`, and the first post-restructure `opencode-plugin-vX.Y.Z` release notes

#### Scenario: An existing install keeps working through the launcher

- **GIVEN** an `opencode.json` written before this change, naming `<HOME>/.config/rembric/bin/rembric-bridge.mjs`
- **WHEN** the user re-runs the install script and then starts opencode
- **THEN** the launcher at that path SHALL spawn the pinned bridge
- **AND** the session SHALL connect and list tools exactly as a new install does

#### Scenario: The launcher carries no logic of its own

- **WHEN** `apps/plugin/bin/rembric-bridge.mjs` is read at HEAD
- **THEN** it SHALL contain no `.rembric` read, no URL construction, no `/healthz` request, and no slug regex
- **AND** its only outbound behaviour SHALL be spawning the pinned bridge with the inherited environment

#### Scenario: The launcher pins an exact version like every other spawn site

- **WHEN** the launcher is read
- **THEN** its package specifier SHALL name an exact `@rembric/mcp-bridge@<x.y.z>` version
- **AND** that version SHALL equal `apps/plugin/package.json::version`

### Requirement: Install script contract

`apps/plugin/.opencode-plugin/install.sh` SHALL:

1. Use `#!/usr/bin/env bash` shebang and `set -euo pipefail`.
2. Create `${HOME}/.config/opencode/plugins/` if missing.
3. Create `${HOME}/.config/rembric/bin/` if missing.
4. Copy (not symlink) `apps/plugin/bin/rembric-bridge.mjs` to `${HOME}/.config/rembric/bin/rembric-bridge.mjs`.
   That file is now the deprecated launcher, copied so an `opencode.json` written before this change keeps working; new configurations never reference it.
5. Copy (not symlink) `apps/plugin/mcp-bridge/rembric-dotenv.mjs` to `${HOME}/.config/rembric/bin/rembric-dotenv.mjs`. The installed plugin's rewritten import names that absolute destination, so the destination is unchanged even though the source moved.
6. Copy (not symlink) `apps/plugin/bin/rembric-plugin-core.mjs` to `${HOME}/.config/rembric/bin/rembric-plugin-core.mjs`.
7. Transform `apps/plugin/.opencode-plugin/plugin.ts` while copying it to `${HOME}/.config/opencode/plugins/rembric.ts`, rewriting **every** dev-time relative import of a shared module to its absolute installed path: `from '../mcp-bridge/rembric-dotenv.mjs'` → `from '${HOME}/.config/rembric/bin/rembric-dotenv.mjs'`, and `from '../bin/rembric-plugin-core.mjs'` → `from '${HOME}/.config/rembric/bin/rembric-plugin-core.mjs'`. Bun's ESM resolver in opencode 1.15.x accepts absolute paths. No other transformation is applied.
8. Set all copied files to `chmod 644` (the bridge and shared libs are invoked as `node <path>`, not directly-executed scripts; the +x bit is unnecessary and reduces attack surface).
9. Print a success banner showing the destination paths.
10. Print the MCP snippet in the `npx` form defined by the transport requirement, with `<REMBRIC_SERVER_URL>` / `<REMBRIC_API_TOKEN>` LEFT AS LITERAL PLACEHOLDERS.
11. Exit 0.

The rewrite verification SHALL cover **every** rewritten import, not one of them. A guard that checks a single destination passes while a second import is left unrewritten, so the installer exits 0 having written a plugin that cannot load — the exact silent failure the guard exists to prevent. When any rewrite fails to take effect, the script SHALL remove the partially-written plugin file and exit non-zero naming the failed rewrite.

Moving the dotenv module's source path is exactly the edit that can reintroduce that failure: the `sed` pattern and the post-rewrite guard both name the old specifier literally, and a guard left checking only the core's destination would pass while the dotenv import stayed relative.

The script SHALL NOT touch `~/.config/opencode/opencode.json`. The script SHALL NOT prompt for input. The script SHALL be idempotent: running it twice SHALL leave the system in the same valid state without error, and the idempotency check SHALL cover every copied file including the shared core.

If any of `apps/plugin/.opencode-plugin/plugin.ts`, `apps/plugin/bin/rembric-bridge.mjs`, `apps/plugin/mcp-bridge/rembric-dotenv.mjs`, or `apps/plugin/bin/rembric-plugin-core.mjs` is missing at install time (operator running it from an unfinished checkout), the script SHALL exit non-zero with a clear stderr message naming the missing path.

#### Scenario: Idempotent re-run

- **WHEN** `install.sh` runs twice in succession
- **THEN** both invocations exit 0
- **AND** every destination file exists after each invocation, including `rembric-plugin-core.mjs`
- **AND** their contents match the source files

#### Scenario: Snippet has expanded $HOME but unexpanded placeholders

- **GIVEN** `$HOME = /Users/alice`
- **WHEN** the install script prints the MCP snippet
- **THEN** the snippet's `command` SHALL be the pinned `npx` form and SHALL contain no `/Users/alice` path — the title's first half describes the form this change replaces, and is kept because a published scenario title cannot be renamed inside a MODIFIED block
- **AND** the snippet contains the literal placeholders `<REMBRIC_SERVER_URL>` and `<REMBRIC_API_TOKEN>` (NOT substituted)

#### Scenario: Missing bridge source aborts

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

- **GIVEN** the installed plugin file references the absolute dotenv path but still carries the relative core import
- **WHEN** `install.sh` completes its rewrite verification
- **THEN** it SHALL exit non-zero naming the failed rewrite
- **AND** it SHALL NOT leave the broken plugin file at `${HOME}/.config/opencode/plugins/rembric.ts`
- **AND** the same SHALL hold with the two rewrites reversed — an absolute core path alongside a surviving relative `../mcp-bridge/rembric-dotenv.mjs` import
