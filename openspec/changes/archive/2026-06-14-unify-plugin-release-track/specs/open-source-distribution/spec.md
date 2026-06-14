## REMOVED Requirements

### Requirement: Release-please MUST run in multi-component manifest mode with four independent components

**Reason:** Replaced by the two-track model below. The six-component setup (`server` + `plugin-shared` + four independent client components, wired by the `node-workspace` cascade) versioned artifacts no consumer installs by version (every client ships from `main`), and its anchor-tag dependency made it fragile — a single un-minted component tag triggered phantom release PRs and version spirals. Collapsing the five plugin components into one removes the cascade, the anchor-tag mechanics, and the whole failure mode.

## ADDED Requirements

### Requirement: Release-please MUST run as two independent tracks — `server` and a unified `plugin`

The repository SHALL configure `release-please-config.json` in manifest mode with **exactly two packages** and SHALL declare **no** `node-workspace`, `linked-versions`, or other grouping plugin. `separate-pull-requests` SHALL be `true`.

The two packages:

- `apps/server` — component `server`, `release-type: node`, `package-name: @rembric/server`, `include-component-in-tag: true`. Tag `server-vX.Y.Z`. Releases only when files under `apps/server/` change. Its release is the trigger for the Docker image publish (see the docker-publish requirement, retained).
- `apps/plugin` — component `plugin`, `release-type: node`, `package-name: @rembric/plugin`, `include-component-in-tag: true`. It SHALL cover the **entire** `apps/plugin/` tree (shared assets AND all four client dirs) — it SHALL declare **no** `exclude-paths`. Tag `plugin-vX.Y.Z`. Releases only when files under `apps/plugin/` change; a plugin release SHALL NOT rebuild the server image.

All four plugin clients SHALL share the single `plugin` version (no per-client independent version). The `plugin` component SHALL update every client version carrier in lock-step via `extra-files`: `apps/plugin/.claude-plugin/plugin.json`, `apps/plugin/.codex-plugin/plugin.json`, the `// @rembric-plugin-version` comment in `apps/plugin/.opencode-plugin/plugin.ts`, and `apps/plugin/.hermes-plugin/plugin.yaml`.

The `.release-please-manifest.json` SHALL declare exactly two entries (`apps/server`, `apps/plugin`). Git tags produced by release-please SHALL follow `<component>-vX.Y.Z` — only `server-` and `plugin-`. Legacy `vX.Y.Z` and per-client tags (`claude-code-plugin-v*`, `codex-plugin-v*`, `opencode-plugin-v*`, `hermes-plugin-v*`, `plugin-shared-v*`) remain in history but SHALL NOT be created by future runs.

There SHALL be no cascade and no anchor-tag dependency: with a single plugin component there is no inter-component dependency edge, so a missing tag can never trigger a history re-scan or a phantom cascade bump.

`apps/plugin/CHANGELOG.md` SHALL be the single user-facing changelog for all plugin changes (shared assets and every client).

#### Scenario: A server-only change bumps only server and publishes Docker

- **WHEN** a contributor merges a `feat:`/`fix:` commit touching only files under `apps/server/`
- **THEN** release-please SHALL open a release PR for the `server` component only, and the merged release SHALL tag `server-vX.Y.Z` and publish the Docker image
- **AND** the `apps/plugin` version SHALL remain unchanged

#### Scenario: A plugin change bumps only the unified plugin and does not rebuild Docker

- **WHEN** a contributor merges a commit touching any file under `apps/plugin/` (a shared asset OR any client dir)
- **THEN** release-please SHALL open a release PR for the `plugin` component only, tag `plugin-vX.Y.Z`, and update `apps/plugin/CHANGELOG.md`
- **AND** the same version SHALL be written to all four client carriers (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.opencode-plugin/plugin.ts` comment, `.hermes-plugin/plugin.yaml`) in lock-step
- **AND** the `publish-docker` job SHALL be skipped (the server image SHALL NOT be rebuilt)

#### Scenario: All plugin clients always share one version

- **WHEN** the `plugin` component releases version `X.Y.Z`
- **THEN** every client's version carrier SHALL read `X.Y.Z` — claude, codex, opencode, and hermes SHALL never diverge in version

#### Scenario: Concurrent release runs queue instead of cancelling

- **GIVEN** two release PRs are merged in quick succession
- **WHEN** `release-please.yml` runs are triggered for both
- **THEN** the workflow's `concurrency` guard (`cancel-in-progress: false`) SHALL queue the second run rather than cancel the first
- **AND** the first run's tag-minting SHALL complete, so no merged release PR is left untagged (and no anchor is lost)

#### Scenario: A merged release PR is auto-tagged with no manual step

- **WHEN** a `server` or `plugin` release PR is merged
- **THEN** because its title carries a `${version}` and there is no grouping plugin, the next release-please run SHALL create the `<component>-vX.Y.Z` tag and GitHub release and relabel the PR `autorelease: tagged`
- **AND** release-please SHALL NOT abort with "untagged, merged release PRs outstanding"

#### Scenario: No phantom or cascade release PRs

- **WHEN** any release PR is merged
- **THEN** release-please SHALL NOT open a cascade or history-rescan release PR for another component (there is no `node-workspace` graph and no per-client component to cascade to)
