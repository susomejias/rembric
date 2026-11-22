## ADDED Requirements

### Requirement: The retired bridge package MUST be deprecated only after a verified plugin release

`@rembric/mcp-bridge` is no longer published: every spawn site runs the bridge files shipped in the plugin tree. Once the first plugin release whose spawn sites run those files has been released and verified end to end, the owner SHALL deprecate the package with exactly:

`npm deprecate @rembric/mcp-bridge "use the Rembric installer"`

The deprecation SHALL NOT be issued before that release, because every client would otherwise see the warning while still depending on the package. It SHALL be issued only after a check confirms that the deprecation warning `npx` prints when it runs a deprecated package goes to stderr, not stdout: a hand-written configuration that still spawns `npx -y @rembric/mcp-bridge@<x.y.z>` speaks MCP over stdout, and a warning written there would corrupt the stream.

No published version of `@rembric/mcp-bridge` SHALL be unpublished. npm keeps every published version installable, so a configuration that pins a published version keeps resolving the version it names.

#### Scenario: No deprecation before the verified release

- **GIVEN** no plugin release whose spawn sites run the plugin-tree bridge has been released and verified
- **WHEN** the npm metadata of `@rembric/mcp-bridge` is read
- **THEN** no version SHALL carry a deprecation message

#### Scenario: The stderr check gates the deprecation

- **GIVEN** the verified release exists
- **WHEN** the check finds that `npx` writes its deprecation warning to stdout
- **THEN** the deprecation SHALL NOT be issued

#### Scenario: The deprecation names the installer

- **GIVEN** the verified release exists and the check has confirmed the `npx` deprecation warning goes to stderr
- **WHEN** the owner deprecates the package
- **THEN** the command run SHALL be exactly `npm deprecate @rembric/mcp-bridge "use the Rembric installer"`

#### Scenario: Deprecated versions stay installable

- **WHEN** the deprecation has been issued
- **THEN** every previously published version of `@rembric/mcp-bridge` SHALL remain on the registry
- **AND** `npx -y @rembric/mcp-bridge@<x.y.z>` for a published `<x.y.z>` SHALL still resolve that version

## MODIFIED Requirements

### Requirement: The repository's release identity MUST be consistent across surfaces

The repo's release identity is **two-component** (`server` + unified `plugin`). The version declared in each component's manifest SHALL match the version release-please last set there, AND the most recent component-prefixed git tag for that component, AND the value reported by the relevant runtime surface:

- `apps/web/package.json::version` ⟷ the most recent `server-vX.Y.Z` git tag ⟷ `GET /healthz` body `version` field ⟷ `ghcr.io/susomejias/rembric:<X.Y.Z>` image tag.
- `apps/plugin/package.json::version` ⟷ the most recent `plugin-vX.Y.Z` git tag. The single `plugin` component covers the WHOLE `apps/plugin/` tree; **all five client carriers share this one version**, kept in sync by the component's `extra-files`: `.claude-plugin/{package,plugin}.json`, `.codex-plugin/{package,plugin}.json`, `.hermes-plugin/plugin.yaml`, the `// @rembric-plugin-version` comment in `.opencode-plugin/plugin.ts`, and `.pi-plugin/package.json`. The last of these is also the version published to npm as `@rembric/pi`, so the npm registry becomes a **sixth** surface the plugin version must agree with.
- `mcp-bridge/package.json::version` ⟷ the same `plugin` version. This transport carrier gives the bridge files a version identity and joins the five client carriers under the one version. The bridge is not published to npm (its manifest declares `"private": true`), so it adds no registry surface: the sixth surface is the registry entry of `@rembric/pi` alone. No spawn site names a bridge version, so there is no bridge pin to keep in agreement.

`release-please` SHALL be the single source of truth for bumping these — `.release-please-manifest.json` carries the authoritative versions and each component's updater (plus the `plugin` component's `extra-files`) synchronizes its surfaces. There is **no `node-workspace` cascade**.

The `server` component SHALL be anchored on the repository root (the `.` path), while its name, tag prefix and publish trigger stay unchanged: which commits release the component and the channel it releases on are separate concerns, and only the first moves. The version the running server reports SHALL still be read from `apps/web/package.json` (the shipped app), which release-please updates as an `extra-files` carrier in the same release PR as the root `package.json`, so the two SHALL always hold the same version.

Legacy `vX.Y.Z` tags (pre-restructure) and the frozen per-client tags (`plugin-shared-v*`, `claude-code-plugin-v*`, `codex-plugin-v*`, `opencode-plugin-v*`, `hermes-plugin-v*`) SHALL be retained in git history (`ghcr.io/susomejias/rembric:v0.17.0` MUST remain pullable) but SHALL NOT be created or updated going forward. The unified `plugin-vX.Y.Z` tag line supersedes the per-client lines.

#### Scenario: Server version drift

- **WHEN** any of the server-side surfaces (`apps/web/package.json::version`, the root `package.json::version` and its manifest entry for `.`, `/healthz`, GHCR tag for a given release) disagree for the same release
- **THEN** the disagreement SHALL be treated as a release-blocking bug; release-please SHALL be the single source of truth for bumping the server in lock-step

#### Scenario: Plugin version drift

- **WHEN** any plugin carrier disagrees with the unified `plugin` version (the `apps/plugin` manifest entry / the most recent `plugin-vX.Y.Z` tag) — e.g. `.hermes-plugin/plugin.yaml::version`, `.claude-plugin/plugin.json::version`, `.pi-plugin/package.json::version`, or `mcp-bridge/package.json::version` differs
- **THEN** the disagreement SHALL be treated as a release-blocking bug
- **AND** release-please (the `plugin` component's updater plus its `extra-files`) SHALL be the only writer to those version fields

#### Scenario: All client carriers move together under the plugin version

- **WHEN** the `plugin` component is bumped (by any commit touching `apps/plugin/`)
- **THEN** all carriers — `.claude-plugin/{package,plugin}.json`, `.codex-plugin/{package,plugin}.json`, `.opencode-plugin/plugin.ts` comment, `.hermes-plugin/plugin.yaml`, `.pi-plugin/package.json`, and `mcp-bridge/package.json` — SHALL be updated to the same new version in the same release PR

#### Scenario: The bridge's pin names the version that release publishes

- **WHEN** a plugin release cuts version `X.Y.Z`
- **THEN** `mcp-bridge/package.json::version` SHALL read `X.Y.Z`
- **AND** no spawn site SHALL carry an `@rembric/mcp-bridge@<x.y.z>` pin, so no pin can name a version that was never published
- **AND** the release SHALL publish no version of `@rembric/mcp-bridge` to npm

#### Scenario: The published npm version matches the plugin tag

- **WHEN** `@rembric/pi` is published for a given release
- **THEN** the published version SHALL equal the `apps/plugin` manifest entry and the `plugin-vX.Y.Z` tag for that release
- **AND** a mismatch SHALL be treated as a release-blocking bug

#### Scenario: Pre-restructure tag continuity

- **WHEN** an operator pulls `ghcr.io/susomejias/rembric:v0.17.0` after the restructure flip
- **THEN** the image SHALL remain pullable from GHCR even though release-please no longer cuts `vX.Y.Z` tags; the image is treated as an unmaintained historical artifact tied to the pre-restructure release line

### Requirement: Release-please MUST run as two independent tracks — `server` and a unified `plugin`

The repository SHALL configure `release-please-config.json` in manifest mode with **exactly two packages** and SHALL declare **no** `node-workspace`, `linked-versions`, or other grouping plugin. `separate-pull-requests` SHALL be `true`. `always-update` SHALL be `true`, so every run rebuilds each open release PR from the current `main`: release-please otherwise leaves an open release PR untouched while its release notes are unchanged, and merging one component's release PR leaves the other conflicting on the shared `.release-please-manifest.json` until someone resolves it by hand — where keeping the wrong side reverts the other component's version.

The two packages:

- `.` (the repository root) — component `server`, `release-type: node`, `package-name: @rembric/web`, `include-component-in-tag: true`. Tag `server-vX.Y.Z`. Its release is the trigger for the Docker image publish (see the docker-publish requirement). The server is built from `apps/web` **and** the workspace packages it bundles (`packages/core`, `packages/db`, `packages/mcp`, `packages/config`), and release-please attributes a commit to a component only by the paths it touches: anchored on `apps/web`, a `feat` or `fix` that changed only a package released nothing and never reached the changelog — measured on this repository, about one server change in four. Anchored on the root, every commit counts unless all the files it touches lie under the component's `exclude-paths`. Those SHALL name `apps/plugin` (the other component) and only directories the image is not built from — specifications, documentation, CI and repository tooling, agent configuration; a directory the Dockerfile copies SHALL NOT be excluded. `exclude-paths` matches directories, not single files, so a root-level file cannot be excluded; that is accepted, because a commit touching only such files is rarely a releasable type. The component's changelog stays `apps/web/CHANGELOG.md`, and `apps/web/package.json` is updated as an `extra-files` carrier, a path below the component directory that needs no `..` segment and no leading slash.
- `apps/plugin` — component `plugin`, `release-type: node`, `package-name: @rembric/plugin`, `include-component-in-tag: true`. It SHALL cover the **entire** `apps/plugin/` tree (shared assets AND all five client dirs) — it SHALL declare **no** `exclude-paths`. Tag `plugin-vX.Y.Z`. Releases only when files under `apps/plugin/` change; a plugin release SHALL NOT rebuild the server image. A plugin release IS the trigger for the `@rembric/pi` npm publish (see the outbound-publication requirement in `supply-chain-hygiene`).

`apps/plugin/mcp-bridge/` — the stdio↔Streamable-HTTP transport, shipped as files in the plugin tree and not published — is part of that tree and is therefore covered by the same component under the same **no `exclude-paths`** rule: a commit touching only it releases `plugin`. A plugin release SHALL NOT publish `@rembric/mcp-bridge` to npm. It is **not** a third package: the config still declares exactly two, and the two-track model (`server` + unified `plugin`) is unchanged by it.

All five plugin clients SHALL share the single `plugin` version (no per-client independent version). The `plugin` component SHALL update every client version carrier in lock-step via `extra-files`: `apps/plugin/.claude-plugin/plugin.json`, `apps/plugin/.codex-plugin/plugin.json`, the `// @rembric-plugin-version` comment in `apps/plugin/.opencode-plugin/plugin.ts`, `apps/plugin/.hermes-plugin/plugin.yaml`, and `apps/plugin/.pi-plugin/package.json`. Every `extra-files` path SHALL be relative to the component directory and SHALL NOT traverse outside it — a `..` segment is rejected by release-please outright. A leading-slash path, by contrast, is resolved against the repository root and so _can_ name a file outside the component; that mechanism SHALL NOT be used here, and its availability is not the reason for the location. **A client that is also an npm-published package SHALL live inside `apps/plugin/` rather than in `packages/` because release-please attributes a release to a component by the paths of the commits under that component's `path`**: a client directory outside `apps/plugin/` would never itself trigger a `plugin` release, so its carrier would be rewritten only when some unrelated change triggered one — which is precisely the lock-step guarantee this requirement exists to provide.

The transport package SHALL share that same single version, and the `plugin` component's `extra-files` SHALL additionally cover `apps/plugin/mcp-bridge/package.json`, under the same component-relative constraint (no leading slash, no `..`). The Claude Code and Codex `mcp.json` manifests name no bridge version and SHALL NOT be `extra-files` entries. The location rule above applies unchanged to a published package that is **not** a client — the attribution mechanism knows nothing about clients, so any package this repository publishes to npm SHALL live inside `apps/plugin/` for the same reason.

The `.release-please-manifest.json` SHALL declare exactly two entries (`.`, `apps/plugin`), and their keys SHALL be exactly the `packages` keys of `release-please-config.json`. Manifest mode matches a package to its version by directory path, so a key present in one and absent from the other would re-bootstrap the component at an implied `0.0.0`. A client being published to npm SHALL NOT make it a component: it is a version carrier of `plugin` and nothing more. Git tags produced by release-please SHALL follow `<component>-vX.Y.Z` — only `server-` and `plugin-`. Legacy `vX.Y.Z` and per-client tags (`claude-code-plugin-v*`, `codex-plugin-v*`, `opencode-plugin-v*`, `hermes-plugin-v*`, `plugin-shared-v*`) remain in history but SHALL NOT be created by future runs.

Neither does its own `package.json` make the transport a component: like the Pi client, it is a version carrier of `plugin` and nothing more.

There SHALL be no cascade and no anchor-tag dependency: with a single plugin component there is no inter-component dependency edge, so a missing tag can never trigger a history re-scan or a phantom cascade bump.

`apps/plugin/CHANGELOG.md` SHALL be the single user-facing changelog for all plugin changes (shared assets and every client). Because all clients share one version, a change scoped to one client bumps the number every other client reports; the CHANGELOG, scoped by conventional commit, is what records which client actually changed.

The transport package is covered by that same changelog: a change scoped to `apps/plugin/mcp-bridge/` bumps the number every client reports, and the conventional-commit scope is what records that the transport — not a client — is what changed.

#### Scenario: A server-only change bumps only server and publishes Docker

- **WHEN** a contributor merges a `feat:`/`fix:` commit touching only files under `apps/web/` or the workspace packages the server bundles
- **THEN** release-please SHALL open a release PR for the `server` component only, and the merged release SHALL tag `server-vX.Y.Z` and publish the Docker image
- **AND** the `apps/plugin` version SHALL remain unchanged
- **AND** no npm package SHALL be published

#### Scenario: A plugin change bumps only the unified plugin and does not rebuild Docker

- **WHEN** a contributor merges a commit touching any file under `apps/plugin/` (a shared asset, any client dir, OR the transport package)
- **THEN** release-please SHALL open a release PR for the `plugin` component only, tag `plugin-vX.Y.Z`, and update `apps/plugin/CHANGELOG.md`
- **AND** the same version SHALL be written to all six carriers (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.opencode-plugin/plugin.ts` comment, `.hermes-plugin/plugin.yaml`, `.pi-plugin/package.json`, and `mcp-bridge/package.json`) in lock-step
- **AND** the `publish-docker` job SHALL be skipped (the server image SHALL NOT be rebuilt)

#### Scenario: A plugin release publishes only the Pi client to npm

- **WHEN** a `plugin` release is created
- **THEN** the `publish-npm` job SHALL publish `@rembric/pi` and SHALL NOT publish `@rembric/mcp-bridge`
- **AND** no `extra-files` entry of the `plugin` component SHALL name `.claude-plugin/mcp.json` or `.codex-plugin/mcp.json`

#### Scenario: A transport-only change causes a plugin release

- **WHEN** a contributor merges a commit whose only changed paths are under `apps/plugin/mcp-bridge/`
- **THEN** release-please SHALL open a release PR for the `plugin` component
- **AND** the transport package SHALL NOT appear as a component of its own

#### Scenario: All plugin clients always share one version

- **WHEN** the `plugin` component releases version `X.Y.Z`
- **THEN** every carrier SHALL read `X.Y.Z` — claude, codex, opencode, hermes, pi and the transport package SHALL never diverge in version

#### Scenario: The manifest is not extended by an npm-published client

- **WHEN** `.release-please-manifest.json` and `release-please-config.json` are read at HEAD
- **THEN** the manifest SHALL declare exactly two entries — `.` and `apps/plugin` — and the config exactly two packages with the same keys
- **AND** every `extra-files` entry of the `plugin` component SHALL be a component-relative path inside `apps/plugin/` — no leading slash, no `..`

#### Scenario: Concurrent release runs queue instead of cancelling

- **GIVEN** two release PRs are merged in quick succession
- **WHEN** `release-please.yml` runs are triggered for both
- **THEN** the `release-please` job's `concurrency` guard (`cancel-in-progress: false`) SHALL queue the second run's `release-please` job rather than cancel the first
- **AND** the first run's tag-minting SHALL complete, so no merged release PR is left untagged (and no anchor is lost)
- **AND** the guard SHALL be scoped to that job, not to the workflow, so a `publish-docker` or `publish-npm` job still running from an earlier release SHALL NOT hold back the next release; each publish job SHALL serialize in its own group with `cancel-in-progress: false` and `queue: max`, so a publish waiting behind another is queued rather than replaced and an already-tagged release never loses its Docker image or npm package

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

#### Scenario: A commit touching only a workspace package releases the server

- **GIVEN** a `feat` or `fix` commit on `main` whose files all lie under `packages/core`, `packages/db` or `packages/mcp`
- **WHEN** release-please runs
- **THEN** it SHALL open or update the `server` release PR, and that commit SHALL appear in its changelog

#### Scenario: A commit touching only excluded directories releases nothing

- **GIVEN** a `feat` or `fix` commit on `main` whose files all lie under directories named in the `server` component's `exclude-paths`, none of them under `apps/plugin`
- **WHEN** release-please runs
- **THEN** it SHALL NOT open a release PR for either component

### Requirement: The npm publish step MUST confirm the registry serves the version it published

After `npm publish` succeeds, `scripts/npm-publish.mjs` SHALL poll the registry for the exact `name@version`, with the same provenance check it applies to an already-published version, until the registry serves it, and SHALL fail the step when that does not happen within a bounded time (15 minutes, checked every 15 seconds). An accepted publish is not an available one: on 2026-11-15, while `@rembric/mcp-bridge` was still published, npm accepted `@rembric/mcp-bridge@0.41.0` and served it about 8 minutes later, while the job reported success and the merged release already pinned that version. The step SHALL apply to every package this repository publishes, which is `@rembric/pi`.

#### Scenario: A publish that npm serves late still passes

- **GIVEN** npm has accepted the publish but the exact version is not served yet
- **WHEN** the step checks the registry
- **THEN** it SHALL wait and check again, and SHALL succeed once the version and its provenance attestation are served

#### Scenario: A publish that is never served fails visibly

- **GIVEN** npm accepted the publish
- **WHEN** the registry has not served the exact version within the bound
- **THEN** the step SHALL fail with a message naming the package, the version and the bound, so the release is not reported as published
