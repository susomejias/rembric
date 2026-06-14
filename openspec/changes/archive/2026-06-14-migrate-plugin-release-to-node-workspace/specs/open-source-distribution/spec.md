## MODIFIED Requirements

### Requirement: The repository's release identity MUST be consistent across surfaces

The repo's release identity is multi-component. The version declared in EACH component's manifest SHALL match the version that release-please last set there, AND SHALL match the most recent component-prefixed git tag for that component, AND SHALL match the value reported by the relevant runtime surface for that component:

- `apps/server/package.json::version` ⟷ the most recent `server-vX.Y.Z` git tag ⟷ `GET /healthz` body `version` field ⟷ `ghcr.io/susomejias/rembric:<X.Y.Z>` image tag.
- `apps/plugin/package.json::version` ⟷ the most recent `plugin-shared-vX.Y.Z` git tag. This component owns ONLY the shared assets (`bin/`, `hooks/`, `commands/`, `scripts/`); the Claude Code and Codex client surfaces are their own components that depend on it.
- `apps/plugin/.claude-plugin/package.json::version` (primary carrier) ⟷ `apps/plugin/.claude-plugin/plugin.json::version` (kept in sync as an `extra-files` updater of the `claude-code-plugin` component) ⟷ the most recent `claude-code-plugin-vX.Y.Z` git tag.
- `apps/plugin/.codex-plugin/package.json::version` (primary carrier) ⟷ `apps/plugin/.codex-plugin/plugin.json::version` (same `extra-files` mechanism) ⟷ the most recent `codex-plugin-vX.Y.Z` git tag.
- `apps/plugin/.hermes-plugin/plugin.yaml::version` ⟷ the most recent `hermes-plugin-vX.Y.Z` git tag.
- The `// @rembric-plugin-version` comment in `apps/plugin/.opencode-plugin/plugin.ts` ⟷ the most recent `opencode-plugin-vX.Y.Z` git tag.

`release-please` SHALL be the single source of truth for bumping these — `.release-please-manifest.json` carries the authoritative versions, each component's own release-type updater (and `extra-files`) synchronizes its surfaces, and the `node-workspace` plugin cascades a patch bump from `@rembric/plugin` to its dependent client components on each release PR.

The legacy `vX.Y.Z` tags (pre-restructure) SHALL be retained in git history for image-pull compatibility (`ghcr.io/susomejias/rembric:v0.17.0` MUST remain pullable) but SHALL NOT be created or updated by release-please going forward. The `claude-code-plugin-vX.Y.Z` and `codex-plugin-vX.Y.Z` tag lines (frozen during the 2026-06-14 collapse at `…v0.11.1`) are RESUMED by this change: future runs SHALL create strictly-greater tags in those lines.

#### Scenario: Server version drift

- **WHEN** any of the four server-side surfaces (`apps/server/package.json::version`, manifest entry for `apps/server`, `/healthz`, GHCR tag for a given release) disagree for the same release
- **THEN** the disagreement SHALL be treated as a release-blocking bug; release-please SHALL be the single source of truth for bumping the server in lock-step

#### Scenario: Plugin component version drift

- **WHEN** any plugin component's manifest version disagrees with its most recent component-prefixed git tag (e.g., `apps/plugin/.hermes-plugin/plugin.yaml::version` differs from the latest `hermes-plugin-vX.Y.Z`, or `apps/plugin/.claude-plugin/package.json::version` differs from the latest `claude-code-plugin-vX.Y.Z`)
- **THEN** the disagreement SHALL be treated as a release-blocking bug
- **AND** release-please (the component's own updater plus `node-workspace` cascade) SHALL be the only writer to those manifest version fields

#### Scenario: Client plugin.json stays in sync with its own package.json

- **WHEN** the `claude-code-plugin` (or `codex-plugin`) component is bumped — whether by a client-scoped commit or by a `node-workspace` cascade from `@rembric/plugin`
- **THEN** both `apps/plugin/.claude-plugin/package.json::version` and `apps/plugin/.claude-plugin/plugin.json::version` (respectively the codex pair) SHALL be updated to the same new version in the same release PR

#### Scenario: Pre-restructure tag continuity

- **WHEN** an operator pulls `ghcr.io/susomejias/rembric:v0.17.0` after the restructure flip
- **THEN** the image SHALL remain pullable from GHCR even though release-please no longer cuts `vX.Y.Z` tags; the image is treated as an unmaintained historical artifact tied to the pre-restructure release line

### Requirement: Release-please MUST run in multi-component manifest mode with four independent components

The repository SHALL configure `release-please-config.json` in manifest mode with exactly six packages and SHALL NOT declare any `linked-versions` (or other grouping) plugin. It SHALL declare the `node-workspace` plugin with `merge: false` to cascade dependency bumps without combining release PRs. `separate-pull-requests` SHALL be `true`.

The six packages:

- `apps/server` — component name `server`, `release-type: node`, `package-name: @rembric/server`, `include-component-in-tag: true`.
- `apps/plugin` — component name `plugin-shared`, `release-type: node`, `package-name: @rembric/plugin`, `include-component-in-tag: true`. Its `exclude-paths` SHALL list ALL FOUR client dirs (`apps/plugin/.claude-plugin`, `.codex-plugin`, `.opencode-plugin`, `.hermes-plugin`), so the component covers ONLY the shared assets (`bin/`, `hooks/`, `commands/`, `scripts/`). It SHALL declare NO `extra-files` for the client manifests (each client owns its own version).
- `apps/plugin/.claude-plugin` — component name `claude-code-plugin`, `release-type: node`, `include-component-in-tag: true`, `extra-files: ["plugin.json"]` (JSON updater for its own `plugin.json::version`). Its `package.json` SHALL be `private: true` and SHALL declare `@rembric/plugin` in `dependencies` so `node-workspace` registers the edge.
- `apps/plugin/.codex-plugin` — component name `codex-plugin`, same shape as `claude-code-plugin` (`extra-files: ["plugin.json"]`, `package.json` depends on `@rembric/plugin`).
- `apps/plugin/.opencode-plugin` — component name `opencode-plugin`, `release-type: simple`, `include-component-in-tag: true`, `extra-files: [{ "type": "generic", "path": "plugin.ts" }]`. It MUST be `simple`, NOT `node`: the `node-workspace` plugin reads a `package.json` for EVERY `node`-type component to build the graph, and opencode has no `package.json` (its version lives in the `plugin.ts` comment). `simple` keeps it out of the graph entirely.
- `apps/plugin/.hermes-plugin` — component name `hermes-plugin`, `release-type: simple`, `include-component-in-tag: true`, `extra-files: ["plugin.yaml"]`. Likewise `simple` and outside the graph.

Every component declared `release-type: node` MUST have a `package.json` at its path, because `node-workspace` reads all node packages to build the dependency graph (verified: a `node` component without a `package.json` aborts the run with `FileNotFoundError`). Re-fetcher components that version via `extra-files` (opencode, hermes) therefore use `release-type: simple` to stay out of the graph.

The rationale for the dependency-graph cascade: Claude Code and Codex are installed via their marketplaces, which **cache** the plugin at a version and bundle `apps/plugin/bin/rembric-bridge.mjs`; a shared-asset change therefore requires both to cut a new version so the cached copy refreshes. Declaring `@rembric/plugin` as a dependency of each client component lets `node-workspace` patch-bump both clients automatically when `@rembric/plugin` releases — while keeping each client's version, tag, and CHANGELOG **independent** (a client-only change bumps only that client). opencode and hermes are **re-fetchers** — their `install.sh` re-pulls shared assets from `main` at install time — so they declare no dependency and remain fully independent components.

The client `package.json` files SHALL be release-please dependency-graph nodes and version carriers ONLY; they SHALL NOT be enlisted as pnpm workspace members (the `apps/*` / `packages/*` globs in `pnpm-workspace.yaml` do not match the nested client dirs). `pnpm install` SHALL ignore them and `pnpm-lock.yaml` SHALL be unaffected by their presence.

Because `merge: false` keeps `node-workspace` from combining release PRs and no `linked-versions` group exists, every release PR is a normal per-component PR whose title carries a `${version}` (e.g. `chore(main): release claude-code-plugin 0.11.2`); merged release PRs are therefore auto-tagged on the next run with no manual intervention.

The `.release-please-manifest.json` SHALL declare exactly these six entries. Git tags produced by release-please SHALL follow `<component>-vX.Y.Z` (`server-`, `plugin-shared-`, `claude-code-plugin-`, `codex-plugin-`, `opencode-plugin-`, `hermes-plugin-`). Legacy `vX.Y.Z` tags remain in history but SHALL NOT be created by future runs.

At migration time, the two re-introduced client components SHALL be seeded with an ANCHOR TAG matching their manifest seed: `claude-code-plugin-v<seed>` and `codex-plugin-v<seed>` SHALL be created at the migration HEAD, where `<seed>` equals the current `apps/plugin/.<client>-plugin/plugin.json::version`. Without a matching anchor tag, release-please re-scans pre-migration history and the first cascade computes an inflated bump (e.g. a stale `feat!` drives a minor instead of the intended `+patch`) — verified in the dry-run. The frozen `…-v0.11.1` tags do NOT serve as anchors because client-dir commits exist between them and HEAD.

#### Scenario: First cascade after migration is a clean patch, not a history re-scan

- **WHEN** the migration seeds `apps/plugin/.claude-plugin` and `apps/plugin/.codex-plugin` in the manifest AND creates matching `claude-code-plugin-v<seed>` / `codex-plugin-v<seed>` anchor tags at HEAD
- **THEN** the next shared-asset change SHALL cascade a `+patch` bump to both clients (computed only from commits after the anchor tag)
- **AND** release-please SHALL NOT re-scan pre-migration commits or inflate the client bump beyond what the post-anchor commits warrant

#### Scenario: A commit touching only apps/server bumps only the server component

- **WHEN** a contributor merges a `feat:` commit that modifies only files under `apps/server/`
- **THEN** release-please SHALL open a PR titled with the `server` component name and version, bumping only `server`
- **AND** the other components' versions in `.release-please-manifest.json` SHALL remain unchanged

#### Scenario: A shared-asset change cascades a patch bump to both client components

- **WHEN** a contributor merges a `feat:` commit modifying `apps/plugin/bin/rembric-bridge.mjs` (or any shared asset under `apps/plugin/` outside the client dirs)
- **THEN** release-please SHALL bump `plugin-shared` AND, via `node-workspace`, cascade a `+patch` bump to BOTH `claude-code-plugin` and `codex-plugin`
- **AND** each bumped component SHALL appear in its OWN separate release PR whose title carries the version (no combined/grouped PR)
- **AND** `opencode-plugin` and `hermes-plugin` versions SHALL remain unchanged

#### Scenario: A Claude-only change bumps only claude-code-plugin

- **WHEN** a contributor merges a commit modifying only files under `apps/plugin/.claude-plugin/`
- **THEN** release-please SHALL open a release PR bumping only `claude-code-plugin`
- **AND** `codex-plugin`, `plugin-shared`, `opencode-plugin`, and `hermes-plugin` versions SHALL remain unchanged
- **AND** the resulting tag SHALL be `claude-code-plugin-vX.Y.Z`

#### Scenario: An opencode-only or hermes-only change bumps only that component

- **WHEN** a contributor merges a commit modifying only `apps/plugin/.opencode-plugin/` (or only `apps/plugin/.hermes-plugin/`)
- **THEN** release-please SHALL open a release PR bumping only `opencode-plugin` (respectively `hermes-plugin`)
- **AND** no other component version SHALL change
- **AND** the resulting tag SHALL be `opencode-plugin-vX.Y.Z` (respectively `hermes-plugin-vX.Y.Z`)

#### Scenario: A merged plugin release PR is auto-tagged with no manual step

- **WHEN** any plugin release PR (a client cascade PR or a `plugin-shared` PR) is merged
- **THEN** because the PR title carries a `${version}`, `merge: false` kept it as a per-component PR, and no `linked-versions` grouping is configured, the next release-please run SHALL create the `<component>-vX.Y.Z` tag and GitHub release and relabel the PR `autorelease: tagged` automatically
- **AND** release-please SHALL NOT abort with "untagged, merged release PRs outstanding"

#### Scenario: Client package.json does not enter the pnpm workspace

- **WHEN** `pnpm install` runs at the repository root after the client `package.json` files are added
- **THEN** `apps/plugin/.claude-plugin` and `apps/plugin/.codex-plugin` SHALL NOT be resolved as workspace packages (the workspace globs do not match nested dirs)
- **AND** `pnpm-lock.yaml` SHALL be byte-identical to its pre-change state
