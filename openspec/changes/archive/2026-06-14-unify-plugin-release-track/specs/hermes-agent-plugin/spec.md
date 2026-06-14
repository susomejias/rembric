## MODIFIED Requirements

### Requirement: Version coupling with other client manifests

The `version` field in `apps/plugin/.hermes-plugin/plugin.yaml` SHALL be managed by the single unified `plugin` release-please component (covering all of `apps/plugin/`, package `@rembric/plugin`, tag `plugin-vX.Y.Z`), via an `extra-files` updater on `plugin.yaml`. Hermes is NO LONGER a separate release-please component, and there is no `node-workspace` cascade.

All four plugin clients (claude, codex, opencode, hermes) share the single `plugin` version — Hermes's `plugin.yaml::version` always equals the current `plugin` version. The `CLAUDE.md` "Releasing a new plugin version" guidance SHALL describe the two-track model (`server` · unified `plugin`), not the former six-component cascade.

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
