## MODIFIED Requirements

### Requirement: Release-please MUST run as two independent tracks — `server` and a unified `plugin`

The repository SHALL configure `release-please-config.json` in manifest mode with **exactly two packages** and SHALL declare **no** `node-workspace`, `linked-versions`, or other grouping plugin. `separate-pull-requests` SHALL be `true`. `always-update` SHALL be `true`, so every run rebuilds each open release PR from the current `main`: release-please otherwise leaves an open release PR untouched while its release notes are unchanged, and merging one component's release PR leaves the other conflicting on the shared `.release-please-manifest.json` until someone resolves it by hand — where keeping the wrong side reverts the other component's version.

The two packages:

- `apps/web` — component `server`, `release-type: node`, `package-name: @rembric/web`, `include-component-in-tag: true`. Tag `server-vX.Y.Z`. Releases only when files under `apps/web/` change. Its release is the trigger for the Docker image publish (see the docker-publish requirement, retained). The component's release identity lives in `apps/web/package.json`; its name and tag prefix are unchanged from when it was anchored on `apps/server`.
- `apps/plugin` — component `plugin`, `release-type: node`, `package-name: @rembric/plugin`, `include-component-in-tag: true`. It SHALL cover the **entire** `apps/plugin/` tree (shared assets AND all five client dirs) — it SHALL declare **no** `exclude-paths`. Tag `plugin-vX.Y.Z`. Releases only when files under `apps/plugin/` change; a plugin release SHALL NOT rebuild the server image. A plugin release IS the trigger for the `@rembric/pi` npm publish (see the outbound-publication requirement in `supply-chain-hygiene`).

`apps/plugin/mcp-bridge/` — the published stdio↔Streamable-HTTP transport package — is part of that tree and is therefore covered by the same component under the same **no `exclude-paths`** rule: a commit touching only it releases `plugin`, and a plugin release is equally the trigger for the `@rembric/mcp-bridge` npm publish. It is **not** a third package: the config still declares exactly two, and the two-track model (`server` + unified `plugin`) is unchanged by it.

All five plugin clients SHALL share the single `plugin` version (no per-client independent version). The `plugin` component SHALL update every client version carrier in lock-step via `extra-files`: `apps/plugin/.claude-plugin/plugin.json`, `apps/plugin/.codex-plugin/plugin.json`, the `// @rembric-plugin-version` comment in `apps/plugin/.opencode-plugin/plugin.ts`, `apps/plugin/.hermes-plugin/plugin.yaml`, and `apps/plugin/.pi-plugin/package.json`. Every `extra-files` path SHALL be relative to the component directory and SHALL NOT traverse outside it — a `..` segment is rejected by release-please outright. A leading-slash path, by contrast, is resolved against the repository root and so _can_ name a file outside the component; that mechanism SHALL NOT be used here, and its availability is not the reason for the location. **A client that is also an npm-published package SHALL live inside `apps/plugin/` rather than in `packages/` because release-please attributes a release to a component by the paths of the commits under that component's `path`**: a client directory outside `apps/plugin/` would never itself trigger a `plugin` release, so its carrier would be rewritten only when some unrelated change triggered one — which is precisely the lock-step guarantee this requirement exists to provide.

The transport package SHALL share that same single version, and the `plugin` component's `extra-files` SHALL additionally cover `apps/plugin/mcp-bridge/package.json` and the two manifest pin sites, under the same component-relative constraint (no leading slash, no `..`). The opencode hook and printed snippet are executable carriers checked by invariant rather than release-please text replacement. A pin is a carrier rather than a hand-maintained constant precisely because it names a package released by the same run: a hand-bumped pin can name a version that was never published, and a carrier cannot. The location rule above applies unchanged to a published package that is **not** a client — the attribution mechanism knows nothing about clients, so any package this repository publishes to npm SHALL live inside `apps/plugin/` for the same reason.

The `.release-please-manifest.json` SHALL declare exactly two entries (`apps/web`, `apps/plugin`), and their keys SHALL be exactly the `packages` keys of `release-please-config.json`. Manifest mode matches a package to its version by directory path, so a key present in one and absent from the other would re-bootstrap the component at an implied `0.0.0`. A client being published to npm SHALL NOT make it a component: it is a version carrier of `plugin` and nothing more. Git tags produced by release-please SHALL follow `<component>-vX.Y.Z` — only `server-` and `plugin-`. Legacy `vX.Y.Z` and per-client tags (`claude-code-plugin-v*`, `codex-plugin-v*`, `opencode-plugin-v*`, `hermes-plugin-v*`, `plugin-shared-v*`) remain in history but SHALL NOT be created by future runs.

Neither does being published to npm make the transport a component: like the Pi client, it is a version carrier of `plugin` and nothing more.

There SHALL be no cascade and no anchor-tag dependency: with a single plugin component there is no inter-component dependency edge, so a missing tag can never trigger a history re-scan or a phantom cascade bump.

`apps/plugin/CHANGELOG.md` SHALL be the single user-facing changelog for all plugin changes (shared assets and every client). Because all clients share one version, a change scoped to one client bumps the number every other client reports; the CHANGELOG, scoped by conventional commit, is what records which client actually changed.

The transport package is covered by that same changelog: a change scoped to `apps/plugin/mcp-bridge/` bumps the number every client reports, and the conventional-commit scope is what records that the transport — not a client — is what changed.

#### Scenario: A server-only change bumps only server and publishes Docker

- **WHEN** a contributor merges a `feat:`/`fix:` commit touching only files under `apps/web/`
- **THEN** release-please SHALL open a release PR for the `server` component only, and the merged release SHALL tag `server-vX.Y.Z` and publish the Docker image
- **AND** the `apps/plugin` version SHALL remain unchanged
- **AND** no npm package SHALL be published

#### Scenario: A plugin change bumps only the unified plugin and does not rebuild Docker

- **WHEN** a contributor merges a commit touching any file under `apps/plugin/` (a shared asset, any client dir, OR the transport package)
- **THEN** release-please SHALL open a release PR for the `plugin` component only, tag `plugin-vX.Y.Z`, and update `apps/plugin/CHANGELOG.md`
- **AND** the same version SHALL be written to all seven carriers (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.opencode-plugin/plugin.ts` comment, `.hermes-plugin/plugin.yaml`, `.pi-plugin/package.json`, `mcp-bridge/package.json`, and the bridge's pinned specifier) in lock-step
- **AND** the `publish-docker` job SHALL be skipped (the server image SHALL NOT be rebuilt)

#### Scenario: A transport-only change causes a plugin release

- **WHEN** a contributor merges a commit whose only changed paths are under `apps/plugin/mcp-bridge/`
- **THEN** release-please SHALL open a release PR for the `plugin` component
- **AND** the transport package SHALL NOT appear as a component of its own

#### Scenario: All plugin clients always share one version

- **WHEN** the `plugin` component releases version `X.Y.Z`
- **THEN** every carrier SHALL read `X.Y.Z` — claude, codex, opencode, hermes, pi and the transport package SHALL never diverge in version

#### Scenario: The manifest is not extended by an npm-published client

- **WHEN** `.release-please-manifest.json` and `release-please-config.json` are read at HEAD
- **THEN** the manifest SHALL declare exactly two entries — `apps/web` and `apps/plugin` — and the config exactly two packages with the same keys
- **AND** every `extra-files` entry of the `plugin` component SHALL be a component-relative path inside `apps/plugin/` — no leading slash, no `..`

#### Scenario: Concurrent release runs queue instead of cancelling

- **GIVEN** two release PRs are merged in quick succession
- **WHEN** `release-please.yml` runs are triggered for both
- **THEN** the `release-please` job's `concurrency` guard (`cancel-in-progress: false`) SHALL queue the second run's `release-please` job rather than cancel the first
- **AND** the first run's tag-minting SHALL complete, so no merged release PR is left untagged (and no anchor is lost)
- **AND** the guard SHALL be scoped to that job, not to the workflow, so a `publish-docker` or `publish-npm` job still running from an earlier release SHALL NOT hold back the next release; each publish job SHALL serialize in its own group with `cancel-in-progress: false`

#### Scenario: Merging one release PR does not leave the other conflicting

- **GIVEN** release PRs are open for both `server` and `plugin`
- **WHEN** one of them is merged
- **THEN** the run triggered by that merge SHALL rebuild the other release PR from the new `main`, so it carries both components' current versions in `.release-please-manifest.json` and merges without a conflict

#### Scenario: A merged release PR is auto-tagged with no manual step

- **WHEN** a `server` or `plugin` release PR is merged
- **THEN** because its title carries a `${version}` and there is no grouping plugin, the next release-please run SHALL create the `<component>-vX.Y.Z` tag and GitHub release and relabel the PR `autorelease: tagged`
- **AND** release-please SHALL NOT abort with "untagged, merged release PRs outstanding"

#### Scenario: No phantom or cascade release PRs

- **WHEN** any release PR is merged
- **THEN** release-please SHALL NOT open a cascade or history-rescan release PR for another component (there is no `node-workspace` graph and no per-client component to cascade to)

## ADDED Requirements

### Requirement: The npm publish step MUST confirm the registry serves the version it published

After `npm publish` succeeds, `scripts/npm-publish.mjs` SHALL poll the registry for the exact `name@version`, with the same provenance check it applies to an already-published version, until the registry serves it, and SHALL fail the step when that does not happen within a bounded time (15 minutes, checked every 15 seconds). An accepted publish is not an available one: on 2026-11-15 npm accepted `@rembric/mcp-bridge@0.41.0` and served it about 8 minutes later, while the job reported success and the merged release already pinned that version.

#### Scenario: A publish that npm serves late still passes

- **GIVEN** npm has accepted the publish but the exact version is not served yet
- **WHEN** the step checks the registry
- **THEN** it SHALL wait and check again, and SHALL succeed once the version and its provenance attestation are served

#### Scenario: A publish that is never served fails visibly

- **GIVEN** npm accepted the publish
- **WHEN** the registry has not served the exact version within the bound
- **THEN** the step SHALL fail with a message naming the package, the version and the bound, so the release is not reported as published
