## MODIFIED Requirements

### Requirement: Plugin source location

The plugin SHALL live in this monorepo at `apps/plugin/.hermes-plugin/`, sibling to `apps/plugin/.claude-plugin/`, `apps/plugin/.codex-plugin/`, and `apps/plugin/.opencode-plugin/`. The directory SHALL contain exactly four files at the top level: `plugin.yaml`, `__init__.py`, `install.sh`, `README.md`. A nested `apps/plugin/.hermes-plugin/tests/` directory MAY exist for Python unittest sources and SHALL NOT ship to end users (the `install.sh` whitelist of three shipped files — `plugin.yaml`, `__init__.py`, `README.md` — is what guarantees this; nothing else under `apps/plugin/.hermes-plugin/` is copied).

#### Scenario: Plugin tree contains the four top-level files

- **WHEN** the repository is at HEAD
- **THEN** `ls apps/plugin/.hermes-plugin/` lists `plugin.yaml`, `__init__.py`, `install.sh`, `README.md`, and the `tests/` directory
- **AND** the only nested directory permitted under `apps/plugin/.hermes-plugin/` is `tests/`, and its contents SHALL NOT be referenced by `install.sh`

### Requirement: Plugin manifest declares lifecycle hooks

`apps/plugin/.hermes-plugin/plugin.yaml` SHALL declare the canonical Hermes manifest fields: `name: "rembric"`, `version: "<semver>"` (managed by release-please's `hermes` component via the `extra-files` updater — NOT in lock-step with other plugin manifests anymore), `description`, `author`, `homepage`. The manifest SHALL declare a `hooks` array listing the lifecycle events the provider implements with real behavior: `[on_session_end, on_pre_compress, on_session_switch]`. The manifest SHALL declare a `requires_env` array listing the three runtime environment variables the plugin needs, in this order and with these descriptors:

1. `name: REMBRIC_SERVER_URL`, `description: "Rembric server base URL (WITHOUT /mcp suffix). Example: https://memory.example.com — no trailing slash."`.
2. `name: REMBRIC_API_TOKEN`, `description: "Bearer token issued from the Rembric dashboard at /dashboard/tokens."`, `secret: true`.
3. `name: REMBRIC_PROJECT_SLUG`, `description: "Default project slug. Overridden per-cwd if a .rembric file is present, or by the trailing /mcp/<slug> segment of REMBRIC_SERVER_URL."`.

Declaring `requires_env` triggers Hermes's documented install-time prompt: `hermes plugins install` asks the user for the three values, writes them to `${HERMES_HOME:-~/.hermes}/.env` via `save_env_value`, and exports them into the running process's `os.environ`. On subsequent Hermes launches the same `.env` is loaded before plugins import. Subprocesses Hermes spawns from `mcp_servers.*` (including the bundled MCP bridge) inherit the same env.

The `hooks` array SHALL include `on_session_switch` because the provider now overrides that method to rotate session ids on compression. Without listing it, Hermes does NOT call the override (the `hooks` array gates lifecycle method invocation).

#### Scenario: Manifest declares hooks and requires_env

- **WHEN** Hermes reads `plugin.yaml` at install time
- **THEN** it sees `hooks: [on_session_end, on_pre_compress, on_session_switch]` and surfaces no other hook bindings
- **AND** it sees `requires_env: [REMBRIC_SERVER_URL, REMBRIC_API_TOKEN, REMBRIC_PROJECT_SLUG]` and prompts the user for any of those not already set in the parent shell env
- **AND** answered values land in `${HERMES_HOME:-~/.hermes}/.env` and become available to the plugin module at import time and to all `mcp_servers.*` subprocesses Hermes spawns

#### Scenario: Version is managed by the hermes release-please component

- **WHEN** a commit modifies any file under `apps/plugin/.hermes-plugin/`
- **THEN** release-please's `hermes` component SHALL detect the change and stage a version bump for `apps/plugin/.hermes-plugin/plugin.yaml`
- **AND** the bump SHALL be independent of the `claude-code`, `codex`, and `opencode` components
- **AND** a `hermes-vX.Y.Z` git tag SHALL be created when the release-please PR is merged

### Requirement: Distribution via curl-installer

The plugin SHALL be installable through a single shell script hosted at `apps/plugin/.hermes-plugin/install.sh` in the rembric monorepo. The script SHALL:

- Default to `PLUGIN_SRC="https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin"`.
- Honour an overriding `PLUGIN_SRC` environment variable that points at any local directory (for developers with a cloned monorepo) or any other reachable URL prefix.
- Honour `HERMES_HOME` (default `${HOME}/.hermes`).
- Create the target directory `${HERMES_HOME}/plugins/rembric/` if it does not exist.
- Copy or fetch exactly three files into the target directory: `plugin.yaml`, `__init__.py`, `README.md`. When `PLUGIN_SRC` resolves to a local path that contains these files, the script SHALL prefer local `cp`; otherwise the script SHALL `curl -fsSL` from the prefix.
- Exit non-zero on any unrecoverable error (target directory cannot be created; all sources for a required file fail). Print a clear `[rembric] error: <reason>` line to stderr before exiting.
- Print a one-line success message identifying the install location and the next step to stdout: `✓ rembric installed at <path>\n  enable: hermes plugins enable rembric`.

The recommended public install command in `README.md` SHALL be:

```
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh
```

The legacy URL `https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh` SHALL return HTTP 404 — no shim file is kept under `plugin/.hermes-plugin/`. The breakage is communicated via the first post-restructure `hermes-vX.Y.Z` release notes (BREAKING), and via the install command published in `README.md`, `docs/agents.md`, and `apps/plugin/.hermes-plugin/README.md`.

The plugin's README and docs SHALL NOT recommend a `git clone + cp -r` two-step install as a parallel path. The curl-installer with `PLUGIN_SRC` covers both the casual-user and the developer-with-clone case.

#### Scenario: Default install fetches the three files via curl

- **WHEN** a user runs `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh` in a fresh shell with `HERMES_HOME` unset
- **THEN** the script creates `${HOME}/.hermes/plugins/rembric/` and writes `plugin.yaml`, `__init__.py`, `README.md` into it
- **AND** stdout includes `✓ rembric installed at` followed by the resolved path

#### Scenario: Developer install reads from local clone

- **WHEN** a developer with a clone of rembric runs `PLUGIN_SRC="$(pwd)/apps/plugin/.hermes-plugin" sh apps/plugin/.hermes-plugin/install.sh`
- **THEN** the three files in the target directory are byte-identical to the files in the local source
- **AND** no network request is issued by the script

#### Scenario: Missing remote file fails loudly

- **WHEN** the script runs with the default `PLUGIN_SRC` and the upstream `plugin.yaml` returns HTTP 404
- **THEN** the script writes `[rembric] error:` to stderr and exits with a non-zero status
- **AND** the target directory may exist but does not contain a half-written `plugin.yaml`

#### Scenario: Legacy install URL returns 404

- **WHEN** a user runs the legacy command `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh`
- **THEN** `curl -fsSL` SHALL fail with a 404 from `raw.githubusercontent.com` and exit non-zero
- **AND** no plugin files SHALL be installed
- **AND** the user SHALL find the corrected install command in the README / docs / release notes

### Requirement: User documentation

The plugin's `README.md` (at `apps/plugin/.hermes-plugin/README.md`) SHALL include, in this order:

1. A one-line install command using `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh`, followed by `hermes plugins install rembric` (or equivalent) to trigger the `requires_env` prompts.
2. A description of what Hermes prompts for during install (the three `requires_env` vars) and where the answers are persisted (`${HERMES_HOME:-~/.hermes}/.env`).
3. A two-block `~/.hermes/config.yaml` example showing **both** the `mcp_servers.rembric` block (registering the bundled bridge via `node` or `npx`) AND the `memory: provider: rembric` block, so users wire both the tool surface and the lifecycle in one go.
4. A short "Project slug resolution" section explaining the four-step cascade in plain prose.
5. A "Troubleshooting" section that covers: provider visible in `hermes memory status` but server unhealthy, missing slug diagnostic, mismatched provider-vs-bridge slug, `~/.hermes/.env` edited manually after install.

The README SHALL NOT mention `~/.rembric/.env`, `${XDG_CONFIG_HOME}/rembric/.env`, `get_config_schema`, `save_config`, or `~/.hermes/rembric.json`. Those mechanisms were removed; documenting them would mislead users into setting up files the plugin ignores.

The repository's root `README.md` SHALL be updated to list Hermes Agent under "Supported clients" alongside Claude Code, Codex CLI, and opencode, with a link to the plugin README at `apps/plugin/.hermes-plugin/README.md`.

`docs/agents.md` SHALL gain (or retain, after path swap) a "Hermes Agent" section mirroring the structure of the existing Claude Code and Codex CLI sections, covering install (including the `requires_env` prompt flow), config, env vars, slug resolution, and a pointer to the plugin README at the new path.

`apps/plugin/README.md` and `apps/plugin/CHANGELOG.md` SHALL be updated to include Hermes alongside the other clients.

#### Scenario: README pairs provider and bridge in the config example

- **WHEN** a user reads `apps/plugin/.hermes-plugin/README.md` end-to-end
- **THEN** the first config block they see registers BOTH the `mcp_servers.rembric` entry (bridge) AND the `memory.provider: rembric` entry (provider) in the same `~/.hermes/config.yaml` snippet
- **AND** the prose preceding the block explicitly notes that lifecycle (provider) and tool access (bridge) are complementary, not redundant
- **AND** the README contains no reference to `~/.rembric/.env` or `get_config_schema`

### Requirement: Version coupling with other client manifests

The `version` field in `apps/plugin/.hermes-plugin/plugin.yaml` SHALL be managed by release-please's `hermes` component independently of the other plugin clients — superseding the previous lock-step rule that pinned Hermes to Claude Code and Codex. Each `apps/plugin/.X-plugin/` SHALL be its own release-please component and SHALL bump when its own paths change. Additionally, the `claude-code` and `codex` components SHALL bump when shared paths under `apps/plugin/bin/`, `hooks/`, `commands/`, or `scripts/` change (via the `bridge-bundlers` linked-versions group).

`hermes` SHALL be excluded from `bridge-bundlers` because the Hermes installer re-fetches from `main` at install time; changes to shared code under `apps/plugin/` reach Hermes users on their next `curl … install.sh | sh` run without requiring a coordinated `hermes-vX.Y.Z` release.

The "Releasing a new plugin version" rule in `CLAUDE.md` SHALL describe this per-component model, replacing the previous lock-step wording.

#### Scenario: A Hermes-only fix produces only a Hermes release

- **WHEN** a contributor merges a `fix:` commit that modifies only files under `apps/plugin/.hermes-plugin/`
- **THEN** release-please SHALL open a release PR that bumps only `hermes`
- **AND** `claude-code`, `codex`, `opencode`, and `server` versions SHALL remain unchanged
- **AND** the resulting git tag SHALL be of the form `hermes-vX.Y.Z`

#### Scenario: A shared-bin change does not produce a Hermes release

- **WHEN** a contributor merges a `feat:` commit that modifies `apps/plugin/bin/rembric-bridge.mjs`
- **THEN** release-please SHALL bump `claude-code` and `codex` (via the `bridge-bundlers` linked group)
- **AND** `hermes` SHALL NOT be bumped
- **AND** Hermes users SHALL receive the updated bridge on their next re-run of the install.sh from `main`

### Requirement: No modification to existing plugin assets

This change SHALL NOT modify the runtime behavior of:

- `apps/plugin/bin/rembric-bridge.mjs`
- `apps/plugin/bin/rembric-dotenv.mjs`
- `apps/plugin/scripts/_api.sh`, `apps/plugin/scripts/session-start.sh`, `apps/plugin/scripts/session-stop.sh`, `apps/plugin/scripts/prompt-search.sh`, `apps/plugin/scripts/session-end.sh`, `apps/plugin/scripts/post-compact.sh`
- `apps/plugin/hooks/hooks.json`, `apps/plugin/hooks/hooks.codex.json`
- `apps/plugin/.claude-plugin/mcp.json`, `apps/plugin/.codex-plugin/mcp.json`
- `apps/server/src/server/api-router.ts` (endpoints, schemas, auth)
- DB schema or migrations
- Existing capability specs in `openspec/specs/` other than the path-swap edits coordinated under this change.

The Hermes plugin consumes the **existing** HTTP session endpoints in `apps/server/src/server/api-router.ts` and the **existing** bridge entry point. No new server-side runtime dependencies are introduced.

#### Scenario: Existing plugin asset paths swap but content is unchanged

- **WHEN** comparing the file at `apps/plugin/bin/rembric-bridge.mjs` (post-restructure) against `plugin/bin/rembric-bridge.mjs` (pre-restructure git history)
- **THEN** the file contents SHALL be byte-identical
- **AND** only the directory path SHALL have changed

#### Scenario: Server endpoints consumed by Hermes are unchanged

- **WHEN** the Hermes provider POSTs `/api/<slug>/sessions/<id>/end` or `/api/<slug>/sessions/<id>/summary`
- **THEN** the server SHALL respond identically to its behaviour before the restructure
- **AND** no new request fields, response shapes, status codes, or auth checks SHALL apply
