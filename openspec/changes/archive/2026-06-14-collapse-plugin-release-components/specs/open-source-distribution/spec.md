## MODIFIED Requirements

### Requirement: The repository's release identity MUST be consistent across surfaces

The repo's release identity is multi-component. The version declared in EACH component's manifest SHALL match the version that release-please last set there, AND SHALL match the most recent component-prefixed git tag for that component, AND SHALL match the value reported by the relevant runtime surface for that component:

- `apps/server/package.json::version` ⟷ the most recent `server-vX.Y.Z` git tag ⟷ `GET /healthz` body `version` field ⟷ `ghcr.io/susomejias/rembric:<X.Y.Z>` image tag.
- `apps/plugin/package.json::version` ⟷ the most recent `plugin-shared-vX.Y.Z` git tag. This component owns the shared assets (`bin/`, `hooks/`, `commands/`, `scripts/`) **and** the Claude Code + Codex client surfaces.
- `apps/plugin/.claude-plugin/plugin.json::version` ⟷ the most recent `plugin-shared-vX.Y.Z` git tag (kept in lock-step by being an `extra-files` updater of the `plugin-shared` component, NOT a separate component).
- `apps/plugin/.codex-plugin/plugin.json::version` ⟷ the most recent `plugin-shared-vX.Y.Z` git tag (same `extra-files` mechanism).
- `apps/plugin/.hermes-plugin/plugin.yaml::version` ⟷ the most recent `hermes-plugin-vX.Y.Z` git tag.
- The `// @rembric-plugin-version` comment in `apps/plugin/.opencode-plugin/plugin.ts` ⟷ the most recent `opencode-plugin-vX.Y.Z` git tag.

`release-please` SHALL be the single source of truth for bumping these — `.release-please-manifest.json` carries the authoritative versions and the corresponding `extra-files` updaters synchronize the surfaces on each release PR.

The legacy `vX.Y.Z` tags (pre-restructure) SHALL be retained in git history for image-pull compatibility (`ghcr.io/susomejias/rembric:v0.17.0` MUST remain pullable) but SHALL NOT be created or updated by release-please going forward. The historical per-client `claude-code-plugin-vX.Y.Z` and `codex-plugin-vX.Y.Z` tags (cut before the merge into `plugin-shared`) SHALL likewise be retained as frozen history and SHALL NOT be created going forward.

#### Scenario: Server version drift

- **WHEN** any of the four server-side surfaces (`apps/server/package.json::version`, manifest entry for `apps/server`, `/healthz`, GHCR tag for a given release) disagree for the same release
- **THEN** the disagreement SHALL be treated as a release-blocking bug; release-please SHALL be the single source of truth for bumping the server in lock-step

#### Scenario: Plugin component version drift

- **WHEN** any plugin component's manifest version disagrees with its most recent component-prefixed git tag (e.g., `apps/plugin/.hermes-plugin/plugin.yaml::version` differs from the latest `hermes-plugin-vX.Y.Z`, or `apps/plugin/.claude-plugin/plugin.json::version` differs from the latest `plugin-shared-vX.Y.Z`)
- **THEN** the disagreement SHALL be treated as a release-blocking bug
- **AND** release-please's `extra-files` mechanism SHALL be the only writer to those manifest version fields

#### Scenario: Pre-restructure tag continuity

- **WHEN** an operator pulls `ghcr.io/susomejias/rembric:v0.17.0` after the restructure flip
- **THEN** the image SHALL remain pullable from GHCR even though release-please no longer cuts `vX.Y.Z` tags; the image is treated as an unmaintained historical artifact tied to the pre-restructure release line

## REMOVED Requirements

### Requirement: Release-please MUST run in multi-component manifest mode with five independent components

**Reason**: The five-component model paired Claude Code + Codex (and later the shared `plugin-shared` component + opencode) in a `linked-versions` group. release-please's `linked-versions` plugin hardcodes the grouped release-PR title to `chore${scope}: release <groupName> libraries` with no `${version}`, so merged group release PRs cannot be parsed back to a version and never get auto-tagged — the next run aborts with "untagged, merged release PRs outstanding" and no new release PR opens. This stalled plugin releases repeatedly. The fix is to stop grouping entirely.

**Migration**: Replaced by "Release-please MUST run in multi-component manifest mode with four independent components" below. Claude Code + Codex are folded into the single `plugin-shared` component (their `plugin.json` files become `extra-files` of it); opencode and hermes stay as their own independent components; the `linked-versions` plugin is removed. No data migration — only `release-please-config.json`, `.release-please-manifest.json`, and the two now-orphaned client CHANGELOG stubs change.

## ADDED Requirements

### Requirement: Release-please MUST run in multi-component manifest mode with four independent components

The repository SHALL configure `release-please-config.json` in manifest mode with exactly four packages, each tied to a single workspace path, and SHALL NOT declare any `linked-versions` (or other grouping) plugin:

- `apps/server` — component name `server`, `release-type: node`, `package-name: @rembric/server`, `include-component-in-tag: true`.
- `apps/plugin` — component name `plugin-shared`, `release-type: node`, `package-name: @rembric/plugin`, `include-component-in-tag: true`. Its `exclude-paths` SHALL list ONLY `apps/plugin/.opencode-plugin` and `apps/plugin/.hermes-plugin`, so the component covers the shared assets (`bin/`, `hooks/`, `commands/`, `scripts/`) **and** the Claude Code (`.claude-plugin/`) and Codex (`.codex-plugin/`) client surfaces. It SHALL declare `extra-files` updating both client manifests' `version` fields: `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` (JSON updater, paths relative to the component root).
- `apps/plugin/.opencode-plugin` — component name `opencode-plugin`, `release-type: node`, `include-component-in-tag: true`, `extra-files: [{ "type": "generic", "path": "plugin.ts" }]`. The generic updater operates on the `// @rembric-plugin-version <semver>` line wrapped in `// x-release-please-start-version` / `// x-release-please-end` markers.
- `apps/plugin/.hermes-plugin` — component name `hermes-plugin`, `release-type: simple`, `include-component-in-tag: true`, `extra-files: ["plugin.yaml"]`.

The rationale for the merge: Claude Code and Codex are installed via their marketplaces, which **cache** the plugin at a version and bundle `apps/plugin/bin/rembric-bridge.mjs`; a shared-asset change therefore requires both to cut a new version so the cached copy refreshes. Folding both into the single `plugin-shared` component bumps them together natively (one PR, one version). opencode and hermes are **re-fetchers** — their `install.sh` re-pulls shared assets from `main` at install time — so they need no coordinated bump and remain independent components.

Because no `linked-versions` group exists, every release PR is a normal per-component PR whose title carries a `${version}` (e.g. `chore(main): release plugin-shared 0.12.0`); merged release PRs are therefore auto-tagged on the next run with no manual intervention.

The `.release-please-manifest.json` SHALL declare exactly these four entries. Git tags produced by release-please SHALL follow `<component>-vX.Y.Z` (`server-vX.Y.Z`, `plugin-shared-vX.Y.Z`, `opencode-plugin-vX.Y.Z`, `hermes-plugin-vX.Y.Z`). Legacy `vX.Y.Z` tags and the frozen pre-merge `claude-code-plugin-vX.Y.Z` / `codex-plugin-vX.Y.Z` tags remain in history but SHALL NOT be created by future runs.

#### Scenario: A commit touching only apps/server bumps only the server component

- **WHEN** a contributor merges a `feat:` commit that modifies only files under `apps/server/`
- **THEN** release-please SHALL open a PR titled with the `server` component name and version, bumping only `server`
- **AND** the other three components' versions in `.release-please-manifest.json` SHALL remain unchanged

#### Scenario: A shared-asset or Claude/Codex change bumps only plugin-shared

- **WHEN** a contributor merges a `feat:` commit modifying `apps/plugin/bin/rembric-bridge.mjs`, or files under `apps/plugin/.claude-plugin/` or `apps/plugin/.codex-plugin/`
- **THEN** release-please SHALL bump ONLY the `plugin-shared` component in a single release PR whose title carries the version
- **AND** both `apps/plugin/.claude-plugin/plugin.json::version` and `apps/plugin/.codex-plugin/plugin.json::version` SHALL be updated via the `extra-files` mechanism, in lock-step with `apps/plugin/package.json::version`
- **AND** `opencode-plugin` and `hermes-plugin` versions SHALL remain unchanged

#### Scenario: An opencode-only or hermes-only change bumps only that component

- **WHEN** a contributor merges a commit modifying only `apps/plugin/.opencode-plugin/` (or only `apps/plugin/.hermes-plugin/`)
- **THEN** release-please SHALL open a release PR bumping only `opencode-plugin` (respectively `hermes-plugin`)
- **AND** no other component version SHALL change
- **AND** the resulting tag SHALL be `opencode-plugin-vX.Y.Z` (respectively `hermes-plugin-vX.Y.Z`)

#### Scenario: A merged plugin release PR is auto-tagged with no manual step

- **WHEN** a `plugin-shared` (or any) release PR is merged
- **THEN** because the PR title carries a `${version}` and no `linked-versions` grouping is configured, the next release-please run SHALL create the `<component>-vX.Y.Z` tag and GitHub release and relabel the PR `autorelease: tagged` automatically
- **AND** release-please SHALL NOT abort with "untagged, merged release PRs outstanding"
