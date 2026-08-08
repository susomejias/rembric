## MODIFIED Requirements

### Requirement: The README MUST accurately describe the current distribution model

`README.md` SHALL describe Rembric's current distribution and install path without referencing distribution mechanisms that have been removed. References to an npm-installed **Rembric server** or to the retired **operator CLI**, and any other deprecated install mechanism, SHALL NOT appear in the README — this is what the prohibition has always been about, and `2026-05-17-remove-cli-and-npm-distribution` is the change that retired both. A **named npm package that is a supported client's own install command** is NOT a deprecated mechanism and is permitted, subject to the TUI-leads rule below: for the Pi client the package **is** the distribution channel, because its package gallery lists by keyword and there is no other discovery path. The README SHALL link to `docs/backup.md` from a prominent install-or-quickstart-adjacent section. The README SHALL link to `SECURITY.md` from the same nav header as `Contributing`.

The README's primary, lead install/upgrade instruction SHALL be the **TUI installer** (the repo-root `install.sh` shim, canonical URL `https://raw.githubusercontent.com/susomejias/rembric/main/install.sh`). The manual Docker quickstart (`curl docker-compose.yml` + `.env.example` + `docker compose up -d`) and the per-client commands SHALL remain in the README only under an explicitly-labelled "Manual / advanced" section, never as the primary path. The Pi install command is a per-client command and SHALL appear only in that section.

When the README does show per-client install URLs (in the manual section), they SHALL point at `https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.<client>-plugin/install.sh` for the curl-pipe-sh clients (Hermes, opencode), and at `https://github.com/susomejias/rembric` for the marketplace-driven clients (Claude Code, Codex CLI — both consumed via `<client> plugin marketplace add <repo-url>`). The Pi client has neither form: its command is `pi install npm:@rembric/pi`, **with no version suffix** (a version-pinned spec is skipped by the harness's own update commands, so documenting one freezes the operator indefinitely). The legacy `plugin/.<client>-plugin/install.sh` URLs SHALL NOT appear in the README; any per-client URL shown SHALL be the canonical `apps/plugin/...` form.

#### Scenario: README leads with the TUI installer

- **WHEN** a third party reads the README's install/quickstart section top-to-bottom
- **THEN** the first install/upgrade command presented SHALL be the TUI installer (`.../main/install.sh`)
- **AND** the manual Docker quickstart and per-client commands — including the Pi install command — SHALL appear only below, under a heading that marks them as manual / advanced

#### Scenario: README stale-claim regression

- **WHEN** a PR re-introduces phrases like "One npm package", "operator CLI", or anchors to removed sections like `#cli-operations`
- **THEN** a CI check or invariant test SHALL flag the regression, OR the reviewer SHALL block the PR with a reference to this requirement

#### Scenario: A supported client's npm install command is not a stale claim

- **WHEN** the README's manual section presents `pi install npm:@rembric/pi`
- **THEN** the stale-claim check SHALL NOT flag it
- **AND** the command SHALL carry no `@<version>` suffix

#### Scenario: README structural elements

- **WHEN** a third party loads the README on GitHub
- **THEN** the page SHALL contain (in order): logo / banner, tagline mentioning Docker as the canonical distribution, anchor nav including links to architecture / quickstart / contributing / SECURITY, a clear "Data and your responsibility" section once `add-data-protection-defaults` lands, and a footer linking to LICENSE and CODE_OF_CONDUCT

#### Scenario: README plugin install URLs point at apps/plugin

- **WHEN** a third party copies a per-client install command (Hermes or opencode) from the README's manual section
- **THEN** the URL SHALL begin with `https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/`
- **AND** the URL SHALL NOT begin with `https://raw.githubusercontent.com/susomejias/rembric/main/plugin/` (legacy form, now returns HTTP 404)

### Requirement: The repository's release identity MUST be consistent across surfaces

The repo's release identity is **two-component** (`server` + unified `plugin`). The version declared in each component's manifest SHALL match the version release-please last set there, AND the most recent component-prefixed git tag for that component, AND the value reported by the relevant runtime surface:

- `apps/server/package.json::version` ⟷ the most recent `server-vX.Y.Z` git tag ⟷ `GET /healthz` body `version` field ⟷ `ghcr.io/susomejias/rembric:<X.Y.Z>` image tag.
- `apps/plugin/package.json::version` ⟷ the most recent `plugin-vX.Y.Z` git tag. The single `plugin` component covers the WHOLE `apps/plugin/` tree; **all five client carriers share this one version**, kept in sync by the component's `extra-files`: `.claude-plugin/{package,plugin}.json`, `.codex-plugin/{package,plugin}.json`, `.hermes-plugin/plugin.yaml`, the `// @rembric-plugin-version` comment in `.opencode-plugin/plugin.ts`, and `.pi-plugin/package.json`. The last of these is also the version published to npm as `@rembric/pi`, so the npm registry becomes a **sixth** surface the plugin version must agree with.

`release-please` SHALL be the single source of truth for bumping these — `.release-please-manifest.json` carries the authoritative versions and each component's updater (plus the `plugin` component's `extra-files`) synchronizes its surfaces. There is **no `node-workspace` cascade**.

Legacy `vX.Y.Z` tags (pre-restructure) and the frozen per-client tags (`plugin-shared-v*`, `claude-code-plugin-v*`, `codex-plugin-v*`, `opencode-plugin-v*`, `hermes-plugin-v*`) SHALL be retained in git history (`ghcr.io/susomejias/rembric:v0.17.0` MUST remain pullable) but SHALL NOT be created or updated going forward. The unified `plugin-vX.Y.Z` tag line supersedes the per-client lines.

#### Scenario: Server version drift

- **WHEN** any of the four server-side surfaces (`apps/server/package.json::version`, manifest entry for `apps/server`, `/healthz`, GHCR tag for a given release) disagree for the same release
- **THEN** the disagreement SHALL be treated as a release-blocking bug; release-please SHALL be the single source of truth for bumping the server in lock-step

#### Scenario: Plugin version drift

- **WHEN** any plugin client carrier disagrees with the unified `plugin` version (the `apps/plugin` manifest entry / the most recent `plugin-vX.Y.Z` tag) — e.g. `.hermes-plugin/plugin.yaml::version`, `.claude-plugin/plugin.json::version` or `.pi-plugin/package.json::version` differs
- **THEN** the disagreement SHALL be treated as a release-blocking bug
- **AND** release-please (the `plugin` component's updater plus its `extra-files`) SHALL be the only writer to those version fields

#### Scenario: All client carriers move together under the plugin version

- **WHEN** the `plugin` component is bumped (by any commit touching `apps/plugin/`)
- **THEN** all client carriers — `.claude-plugin/{package,plugin}.json`, `.codex-plugin/{package,plugin}.json`, `.opencode-plugin/plugin.ts` comment, `.hermes-plugin/plugin.yaml`, and `.pi-plugin/package.json` — SHALL be updated to the same new version in the same release PR

#### Scenario: The published npm version matches the plugin tag

- **WHEN** `@rembric/pi` is published for a given release
- **THEN** the published version SHALL equal the `apps/plugin` manifest entry and the `plugin-vX.Y.Z` tag for that release
- **AND** a mismatch SHALL be treated as a release-blocking bug

#### Scenario: Pre-restructure tag continuity

- **WHEN** an operator pulls `ghcr.io/susomejias/rembric:v0.17.0` after the restructure flip
- **THEN** the image SHALL remain pullable from GHCR even though release-please no longer cuts `vX.Y.Z` tags; the image is treated as an unmaintained historical artifact tied to the pre-restructure release line

### Requirement: Release-please MUST run as two independent tracks — `server` and a unified `plugin`

The repository SHALL configure `release-please-config.json` in manifest mode with **exactly two packages** and SHALL declare **no** `node-workspace`, `linked-versions`, or other grouping plugin. `separate-pull-requests` SHALL be `true`.

The two packages:

- `apps/server` — component `server`, `release-type: node`, `package-name: @rembric/server`, `include-component-in-tag: true`. Tag `server-vX.Y.Z`. Releases only when files under `apps/server/` change. Its release is the trigger for the Docker image publish (see the docker-publish requirement, retained).
- `apps/plugin` — component `plugin`, `release-type: node`, `package-name: @rembric/plugin`, `include-component-in-tag: true`. It SHALL cover the **entire** `apps/plugin/` tree (shared assets AND all five client dirs) — it SHALL declare **no** `exclude-paths`. Tag `plugin-vX.Y.Z`. Releases only when files under `apps/plugin/` change; a plugin release SHALL NOT rebuild the server image. A plugin release IS the trigger for the `@rembric/pi` npm publish (see the outbound-publication requirement in `supply-chain-hygiene`).

All five plugin clients SHALL share the single `plugin` version (no per-client independent version). The `plugin` component SHALL update every client version carrier in lock-step via `extra-files`: `apps/plugin/.claude-plugin/plugin.json`, `apps/plugin/.codex-plugin/plugin.json`, the `// @rembric-plugin-version` comment in `apps/plugin/.opencode-plugin/plugin.ts`, `apps/plugin/.hermes-plugin/plugin.yaml`, and `apps/plugin/.pi-plugin/package.json`. Every `extra-files` path SHALL be relative to the component directory and SHALL NOT traverse outside it — a `..` segment is rejected by release-please outright. A leading-slash path, by contrast, is resolved against the repository root and so *can* name a file outside the component; that mechanism SHALL NOT be used here, and its availability is not the reason for the location. **A client that is also an npm-published package SHALL live inside `apps/plugin/` rather than in `packages/` because release-please attributes a release to a component by the paths of the commits under that component's `path`**: a client directory outside `apps/plugin/` would never itself trigger a `plugin` release, so its carrier would be rewritten only when some unrelated change triggered one — which is precisely the lock-step guarantee this requirement exists to provide.

The `.release-please-manifest.json` SHALL declare exactly two entries (`apps/server`, `apps/plugin`). A client being published to npm SHALL NOT make it a component: it is a version carrier of `plugin` and nothing more. Git tags produced by release-please SHALL follow `<component>-vX.Y.Z` — only `server-` and `plugin-`. Legacy `vX.Y.Z` and per-client tags (`claude-code-plugin-v*`, `codex-plugin-v*`, `opencode-plugin-v*`, `hermes-plugin-v*`, `plugin-shared-v*`) remain in history but SHALL NOT be created by future runs.

There SHALL be no cascade and no anchor-tag dependency: with a single plugin component there is no inter-component dependency edge, so a missing tag can never trigger a history re-scan or a phantom cascade bump.

`apps/plugin/CHANGELOG.md` SHALL be the single user-facing changelog for all plugin changes (shared assets and every client). Because all clients share one version, a change scoped to one client bumps the number every other client reports; the CHANGELOG, scoped by conventional commit, is what records which client actually changed.

#### Scenario: A server-only change bumps only server and publishes Docker

- **WHEN** a contributor merges a `feat:`/`fix:` commit touching only files under `apps/server/`
- **THEN** release-please SHALL open a release PR for the `server` component only, and the merged release SHALL tag `server-vX.Y.Z` and publish the Docker image
- **AND** the `apps/plugin` version SHALL remain unchanged
- **AND** no npm package SHALL be published

#### Scenario: A plugin change bumps only the unified plugin and does not rebuild Docker

- **WHEN** a contributor merges a commit touching any file under `apps/plugin/` (a shared asset OR any client dir)
- **THEN** release-please SHALL open a release PR for the `plugin` component only, tag `plugin-vX.Y.Z`, and update `apps/plugin/CHANGELOG.md`
- **AND** the same version SHALL be written to all five client carriers (`.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, `.opencode-plugin/plugin.ts` comment, `.hermes-plugin/plugin.yaml`, `.pi-plugin/package.json`) in lock-step
- **AND** the `publish-docker` job SHALL be skipped (the server image SHALL NOT be rebuilt)

#### Scenario: All plugin clients always share one version

- **WHEN** the `plugin` component releases version `X.Y.Z`
- **THEN** every client's version carrier SHALL read `X.Y.Z` — claude, codex, opencode, hermes, and pi SHALL never diverge in version

#### Scenario: The manifest is not extended by an npm-published client

- **WHEN** `.release-please-manifest.json` and `release-please-config.json` are read at HEAD
- **THEN** the manifest SHALL declare exactly two entries and the config exactly two packages
- **AND** every `extra-files` entry of the `plugin` component SHALL be a component-relative path inside `apps/plugin/` — no leading slash, no `..`

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
