## MODIFIED Requirements

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

A version comment of the form `// @rembric-plugin-version <semver>` SHALL appear in the first 5 lines of `plugin.ts`. opencode has no manifest to declare a version; the comment is the only place to record it for diagnostics. The version SHALL be managed by release-please's `opencode` component via the `extra-files` generic updater (NOT in lock-step with other plugin components — opencode versions independently).

#### Scenario: Plugin file declares its version

- **WHEN** the file is read at HEAD
- **THEN** one of the first five lines matches `^// @rembric-plugin-version \d+\.\d+\.\d+$`
- **AND** the captured version equals the most recent `opencode-vX.Y.Z` git tag

#### Scenario: Plugin module loads under Bun

- **WHEN** Bun resolves `~/.config/opencode/plugins/rembric.ts` at opencode startup with `@opencode-ai/plugin` available
- **THEN** the import succeeds without error
- **AND** the exported `RembricPlugin` is an async function
- **AND** calling `RembricPlugin(ctx)` returns a Promise whose resolved value is a plain object with event-handler properties

#### Scenario: Version is managed by the opencode release-please component

- **WHEN** a commit modifies only files under `apps/plugin/.opencode-plugin/`
- **THEN** release-please's `opencode` component SHALL stage a version bump for the `// @rembric-plugin-version` comment in `plugin.ts`
- **AND** the bump SHALL be independent of `claude-code`, `codex`, `hermes`, and `server`
- **AND** a `opencode-vX.Y.Z` git tag SHALL be created when the release-please PR is merged

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
- **AND** the corrected install command SHALL be discoverable in `README.md`, `docs/agents.md`, `apps/plugin/.opencode-plugin/README.md`, and the first post-restructure `opencode-vX.Y.Z` release notes

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
