## MODIFIED Requirements

### Requirement: Plugin manifest declares lifecycle hooks

`apps/plugin/.hermes-plugin/plugin.yaml` SHALL declare the canonical Hermes manifest fields: `name: "rembric"`, `version: "<semver>"` (managed by the unified `plugin` release-please component via its `extra-files` updater — in lock-step with the other clients; all clients share the one `plugin` version), `description`, `author`, `homepage`. The manifest SHALL declare a `hooks` array listing the lifecycle events the provider implements with real behavior: `[on_session_end, on_pre_compress, on_session_switch]`. The manifest SHALL declare a `requires_env` array listing the three runtime environment variables the plugin needs, in this order and with these descriptors:

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

#### Scenario: Version is managed by the unified plugin release-please component

- **WHEN** a commit modifies any file under `apps/plugin/`
- **THEN** the unified `plugin` component SHALL stage a version bump for `apps/plugin/.hermes-plugin/plugin.yaml` (alongside every other client carrier)
- **AND** every client SHALL share the one `plugin` version (independent only of `server`)
- **AND** a `plugin-vX.Y.Z` git tag SHALL be created when the release-please PR is merged

### Requirement: Version coupling with other client manifests

The `version` field in `apps/plugin/.hermes-plugin/plugin.yaml` SHALL be managed by the single unified `plugin` release-please component (covering all of `apps/plugin/`, package `@rembric/plugin`, tag `plugin-vX.Y.Z`), via an `extra-files` updater on `plugin.yaml`. Hermes is NO LONGER a separate release-please component, and there is no `node-workspace` cascade.

All plugin clients (claude, codex, opencode, hermes, pi) share the single `plugin` version — Hermes's `plugin.yaml::version` always equals the current `plugin` version. The `CLAUDE.md` "Releasing a new plugin version" guidance SHALL describe the two-track model (`server` · unified `plugin`), not the former six-component cascade. A client that is additionally published to a package registry does NOT get its own component or its own version line; it is one more `extra-files` carrier of the same `plugin` version.

Hermes users still receive shared-asset updates on their next `curl … install.sh | sh` (the installer re-fetches from `main`); the unified version is bookkeeping/changelog, independent of how shared code reaches an install.

#### Scenario: A Hermes-only change bumps the unified plugin component

- **WHEN** a contributor merges a `fix:` commit modifying only files under `apps/plugin/.hermes-plugin/`
- **THEN** release-please SHALL open a release PR for the `plugin` component (tag `plugin-vX.Y.Z`), updating `plugin.yaml::version` alongside the other client carriers
- **AND** the `server` version SHALL remain unchanged and the server image SHALL NOT be rebuilt
- **AND** no separate `hermes-plugin` component / `hermes-plugin-v*` tag SHALL exist

#### Scenario: A shared-bin change bumps the one plugin version

- **WHEN** a contributor merges a `feat:` commit modifying `apps/plugin/bin/rembric-bridge.mjs`
- **THEN** release-please SHALL bump the single `plugin` component, moving `plugin.yaml::version` to the same new version as every other client
- **AND** Hermes users SHALL receive the updated bridge on their next re-run of the installer from `main`

#### Scenario: A change to a registry-published client still bumps Hermes's carrier

- **WHEN** a contributor merges a commit modifying only `apps/plugin/.pi-plugin/`
- **THEN** `plugin.yaml::version` SHALL be moved to the same new `plugin` version in the same release PR
- **AND** the changelog entry, scoped by conventional commit, SHALL identify which client actually changed
