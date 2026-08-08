## MODIFIED Requirements

### Requirement: Plugin source location

The plugin SHALL live in this monorepo at `apps/plugin/.opencode-plugin/`, sibling to `apps/plugin/.claude-plugin/`, `apps/plugin/.codex-plugin/`, `apps/plugin/.hermes-plugin/`, and `apps/plugin/.pi-plugin/`. The directory SHALL contain exactly four files at the top level: `plugin.ts`, `install.sh`, `uninstall.sh`, `README.md`. A co-located test file `plugin.test.ts` MAY exist alongside `plugin.ts` for vitest-based unit testing; the test file is NOT distributed to users.

The plugin SHALL NOT carry its own copy of the dotenv parser, slug regex, or `readRembricSlug` function, nor of any cross-client session-protocol logic (nudge strings, `<private>` redaction, truncation, the stderr diagnostic, the session HTTP client, the transcript accumulator, the summary-body builder, the flush helpers). Those live in two shared modules under `apps/plugin/bin/`, each the single source of truth for its area: `rembric-dotenv.mjs` (slug parsing, also consumed by `apps/plugin/bin/rembric-bridge.mjs`) and `rembric-plugin-core.mjs` (session protocol, also consumed by the Pi client). `plugin.ts` imports from both via relative paths at source time (`../bin/rembric-dotenv.mjs`, `../bin/rembric-plugin-core.mjs`); `install.sh` rewrites **each** path to its absolute installed location before copying.

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
- **THEN** it contains an import referencing `../bin/rembric-dotenv.mjs` and an import referencing `../bin/rembric-plugin-core.mjs`
- **AND** it declares no local `stripPrivateTags`, no local nudge string constant, and no local session-POST helper

### Requirement: Shared dotenv lib SHALL be the single source of truth for slug parsing

The repository SHALL contain `apps/plugin/bin/rembric-dotenv.mjs` exporting exactly: `parseDotenv(content: string)`, `readRembricSlug(directory: string)`, and `SLUG_RE`. This module SHALL be the only place where the slug regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` and the dotenv parser live in JS/TS form across the entire repository.

`apps/plugin/bin/rembric-bridge.mjs` SHALL import `parseDotenv` and `SLUG_RE` from `./rembric-dotenv.mjs`. `apps/plugin/.opencode-plugin/plugin.ts` and `apps/plugin/.pi-plugin/index.ts` SHALL import `readRembricSlug` from `../bin/rembric-dotenv.mjs`. No client file SHALL define its own copy of these helpers.

Bash (`apps/plugin/scripts/_api.sh::rembric_parse_dotenv` and `::rembric_read_project_slug`) and Python (`apps/plugin/.hermes-plugin/__init__.py::_SLUG_RE`) clients keep their own implementations because cross-language wrapping a 20-line parser costs more than the duplication. Those implementations MUST agree on the regex.

An invariant test in `apps/server/src/test/invariants.test.ts` SHALL fail the build if any JS/TS client file, or `rembric-bridge.mjs`, declares its own `parseDotenv` function or `SLUG_RE` constant. The invariant test SHALL reference the canonical path `apps/plugin/bin/rembric-dotenv.mjs` in its assertions.

The set of files the invariant scans SHALL be **derived by a repository-wide search**, not hard-coded, and the invariant SHALL assert a **non-zero** scanned-file count. A hard-coded two-file list does not scan a client added later, and a negative assertion over an empty list passes vacuously — both were true of the version this requirement replaces.

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

#### Scenario: Every other JS/TS consumer imports from the shared lib too

- **WHEN** the repository is at HEAD
- **THEN** every JS/TS client entrypoint the invariant scans contains an import statement referencing the shared dotenv module
- **AND** none of them contains a local `function parseDotenv` or `SLUG_RE = /`
- **AND** the scanned set includes `apps/plugin/.pi-plugin/index.ts`

#### Scenario: Invariant test catches drift

- **GIVEN** a future change introduces a local `function parseDotenv` inside any JS/TS client file or `rembric-bridge.mjs`
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

### Requirement: Install script contract

`apps/plugin/.opencode-plugin/install.sh` SHALL:

1. Use `#!/usr/bin/env bash` shebang and `set -euo pipefail`.
2. Create `${HOME}/.config/opencode/plugins/` if missing.
3. Create `${HOME}/.config/rembric/bin/` if missing.
4. Copy (not symlink) `apps/plugin/bin/rembric-bridge.mjs` to `${HOME}/.config/rembric/bin/rembric-bridge.mjs`.
5. Copy (not symlink) `apps/plugin/bin/rembric-dotenv.mjs` to `${HOME}/.config/rembric/bin/rembric-dotenv.mjs`. The bridge imports from this file via the relative path `./rembric-dotenv.mjs`, so the two files MUST land together in the same directory.
6. Copy (not symlink) `apps/plugin/bin/rembric-plugin-core.mjs` to `${HOME}/.config/rembric/bin/rembric-plugin-core.mjs`.
7. Transform `apps/plugin/.opencode-plugin/plugin.ts` while copying it to `${HOME}/.config/opencode/plugins/rembric.ts`, rewriting **every** dev-time relative import of a shared module to its absolute installed path: `from '../bin/rembric-dotenv.mjs'` → `from '${HOME}/.config/rembric/bin/rembric-dotenv.mjs'`, and `from '../bin/rembric-plugin-core.mjs'` → `from '${HOME}/.config/rembric/bin/rembric-plugin-core.mjs'`. Bun's ESM resolver in opencode 1.15.x accepts absolute paths. No other transformation is applied.
8. Set all copied files to `chmod 644` (the bridge and shared libs are invoked as `node <path>`, not directly-executed scripts; the +x bit is unnecessary and reduces attack surface).
9. Print a success banner showing the destination paths.
10. Print the MCP snippet with `${HOME}` substituted (real absolute path) and `<REMBRIC_SERVER_URL>` / `<REMBRIC_API_TOKEN>` LEFT AS LITERAL PLACEHOLDERS.
11. Exit 0.

The rewrite verification SHALL cover **every** rewritten import, not one of them. A guard that checks a single destination passes while a second import is left unrewritten, so the installer exits 0 having written a plugin that cannot load — the exact silent failure the guard exists to prevent. When any rewrite fails to take effect, the script SHALL remove the partially-written plugin file and exit non-zero naming the failed rewrite.

The script SHALL NOT touch `~/.config/opencode/opencode.json`. The script SHALL NOT prompt for input. The script SHALL be idempotent: running it twice SHALL leave the system in the same valid state without error, and the idempotency check SHALL cover every copied file including the shared core.

If any of `apps/plugin/.opencode-plugin/plugin.ts`, `apps/plugin/bin/rembric-bridge.mjs`, `apps/plugin/bin/rembric-dotenv.mjs`, or `apps/plugin/bin/rembric-plugin-core.mjs` is missing at install time (operator running it from an unfinished checkout), the script SHALL exit non-zero with a clear stderr message naming the missing path.

#### Scenario: Idempotent re-run

- **WHEN** `install.sh` runs twice in succession
- **THEN** both invocations exit 0
- **AND** every destination file exists after each invocation, including `rembric-plugin-core.mjs`
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

#### Scenario: A single unrewritten import aborts the install

- **GIVEN** the installed plugin file references the absolute dotenv path but still carries the relative core import
- **WHEN** `install.sh` completes its rewrite verification
- **THEN** it SHALL exit non-zero naming the failed rewrite
- **AND** it SHALL NOT leave the broken plugin file at `${HOME}/.config/opencode/plugins/rembric.ts`

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
