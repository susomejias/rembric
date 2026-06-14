## MODIFIED Requirements

### Requirement: Plugin version managed by release-please as an independent component

The version recorded in `apps/plugin/.opencode-plugin/plugin.ts`'s `// @rembric-plugin-version` comment SHALL track the single unified `plugin` release-please component (covering all of `apps/plugin/`, package `@rembric/plugin`, tag `plugin-vX.Y.Z`). opencode is NO LONGER a separate release-please component; its version carrier is updated by the `plugin` component via an `extra-files` generic updater on `plugin.ts` (between the `x-release-please-*` markers). There is no `node-workspace` plugin and no per-client component.

All four plugin clients (claude, codex, opencode, hermes) share the single `plugin` version — they never diverge. Operators do NOT hand-edit version surfaces; Conventional Commits drive bumps via release-please.

#### Scenario: An opencode-scoped change bumps the unified plugin component

- **WHEN** a Conventional Commit touching `apps/plugin/.opencode-plugin/` lands on `main`
- **THEN** release-please SHALL open (or update) a release PR for the `plugin` component, bumping `plugin-vX.Y.Z` and writing the new version into the `// @rembric-plugin-version` comment (alongside every other client carrier)
- **AND** no separate `opencode-plugin` component / `opencode-plugin-v*` tag SHALL exist

#### Scenario: A shared-asset change bumps the one plugin version (all clients together)

- **WHEN** a Conventional Commit modifies a shared file under `apps/plugin/bin/` or `apps/plugin/scripts/`
- **THEN** release-please SHALL bump the single `plugin` component, and the opencode `// @rembric-plugin-version` comment SHALL move to the same new version as every other client
- **AND** the server image SHALL NOT be rebuilt (the `plugin` release does not trigger `publish-docker`)
