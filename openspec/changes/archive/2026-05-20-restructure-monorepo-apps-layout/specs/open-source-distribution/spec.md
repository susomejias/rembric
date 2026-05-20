## ADDED Requirements

### Requirement: Release-please MUST run in multi-component manifest mode with five independent components

The repository SHALL configure `release-please-config.json` in manifest mode with exactly five packages, each tied to a single workspace path:

- `apps/server` — component name `server`, `release-type: node`, `package-name: @rembric/server`, `include-component-in-tag: true`.
- `apps/plugin/.claude-plugin` — component name `claude-code`, `release-type: simple`, `include-component-in-tag: true`, `extra-files: ["plugin.json"]`.
- `apps/plugin/.codex-plugin` — component name `codex`, `release-type: simple`, `include-component-in-tag: true`, `extra-files: ["plugin.json"]`.
- `apps/plugin/.hermes-plugin` — component name `hermes`, `release-type: simple`, `include-component-in-tag: true`, `extra-files: ["plugin.yaml"]`.
- `apps/plugin/.opencode-plugin` — component name `opencode`, `release-type: node`, `include-component-in-tag: true`, `extra-files: [{ "type": "generic", "path": "plugin.ts" }]` (the generic updater bumps the `// @rembric-plugin-version` header).

`release-please-config.json` SHALL also declare a `plugins` array containing one `linked-versions` entry with `groupName: "bridge-bundlers"` and `components: ["claude-code", "codex"]`. This causes any release-please-eligible commit affecting either component to bump both — modelling the fact that both marketplace consumers extract `apps/plugin/` as a self-contained root and bundle the shared `bin/`, `hooks/`, `commands/`, `scripts/`. `hermes` and `opencode` SHALL NOT participate in any linked-versions group because their installers re-fetch from `main` at install time.

The `.release-please-manifest.json` SHALL declare five entries with one initial version per component. The first server release after the restructure SHALL be `server-v0.18.0` (minor bump from the previous `v0.17.0` — semantics unchanged, only layout moved). The four plugin components SHALL each start at the version currently declared in their respective manifests (today `0.8.0`).

Git tags produced by release-please SHALL follow the format `<component>-vX.Y.Z` (e.g., `server-v0.18.0`, `claude-code-v0.9.0`). The legacy `vX.Y.Z` tags continue to exist in git history but SHALL NOT be created by future release-please runs.

#### Scenario: A commit touching only apps/server bumps only the server component

- **GIVEN** the repo is configured with the 5-component manifest
- **WHEN** a contributor merges a `feat:` commit that modifies only files under `apps/server/`
- **THEN** release-please SHALL open a PR titled with the `server` component name and bumping only `server`'s version
- **AND** the other four components' versions in `.release-please-manifest.json` SHALL remain unchanged

#### Scenario: A commit touching shared plugin code bumps both linked bundlers

- **WHEN** a contributor merges a `feat:` commit that modifies `apps/plugin/bin/rembric-bridge.mjs`
- **THEN** release-please SHALL bump BOTH `claude-code` and `codex` components in a single coordinated release PR
- **AND** `hermes` and `opencode` versions SHALL remain unchanged
- **AND** both `apps/plugin/.claude-plugin/plugin.json::version` and `apps/plugin/.codex-plugin/plugin.json::version` SHALL be updated via the `extra-files` mechanism

#### Scenario: A Hermes-only fix cuts only a Hermes release

- **WHEN** a contributor merges a `fix:` commit that modifies only `apps/plugin/.hermes-plugin/__init__.py`
- **THEN** release-please SHALL open a release PR bumping only `hermes`
- **AND** no other component versions SHALL change
- **AND** the resulting tag SHALL be of the form `hermes-vX.Y.Z`

### Requirement: docker-publish MUST run only when the server component releases

The `.github/workflows/release-please.yml` workflow SHALL gate the `publish-docker` job on the `apps/server` path being present in the release-please-action's `paths_released` output (or whichever equivalent output key the pinned release-please-action version emits). When `apps/server` is NOT in `paths_released`, `publish-docker` SHALL NOT run, even if other components were released in the same workflow invocation.

This SHALL be expressed as a job-level `if:` condition such as `if: ${{ fromJSON(needs.release-please.outputs.paths_released)['apps/server'] != null }}` or equivalent depending on the action's actual output shape.

A `workflow_dispatch` manual override SHALL remain available on `docker-publish.yml` for operator recovery (first-time bootstrap, smoke-test publish of a specific tag) — invoked outside the automatic gate.

#### Scenario: Plugin-only release does not publish Docker

- **GIVEN** a release-please PR is merged that bumps only the `claude-code` and `codex` components
- **WHEN** `release-please.yml` runs to completion
- **THEN** the `publish-docker` job SHALL be skipped (status `skipped`, not `failed`)
- **AND** no new image SHALL appear at `ghcr.io/susomejias/rembric:*`

#### Scenario: Server release does publish Docker

- **GIVEN** a release-please PR is merged that bumps the `server` component (alone or alongside others)
- **WHEN** `release-please.yml` runs to completion
- **THEN** the `publish-docker` job SHALL run with the new server version's tag
- **AND** a new immutable image SHALL appear at `ghcr.io/susomejias/rembric:<new-version>`
- **AND** the post-publish smoke test SHALL gate alias promotion (:latest, major, minor) as already specified by development-environment

### Requirement: Legacy plugin install URLs return 404 — no shim

The directories `plugin/.hermes-plugin/` and `plugin/.opencode-plugin/` SHALL NOT be re-added to the repository tree after the `apps/plugin/` move. Bookmarked old `raw.githubusercontent.com/.../main/plugin/.X-plugin/install.sh` URLs SHALL return HTTP 404. The breakage SHALL be called out as **BREAKING** in the first post-restructure `hermes-vX.Y.Z` and `opencode-vX.Y.Z` release notes, and the corrected install command SHALL be discoverable in `README.md`, `docs/agents.md`, and the per-client READMEs at `apps/plugin/.<client>-plugin/README.md`.

This is a hard cutover by design — maintaining shim files (and remembering to delete them in 3-6 months) was rejected as more drag than the marginal UX recovery. The 404 is short, unambiguous, and forces the user to re-read the install docs, which are the canonical source of truth.

#### Scenario: Legacy URL hits return 404

- **WHEN** a user runs `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.opencode-plugin/install.sh | sh` after the change lands
- **THEN** `curl -fsSL` SHALL receive an HTTP 404 from `raw.githubusercontent.com` and exit non-zero
- **AND** no files SHALL be created in the user's `~/.config/opencode/` or `~/.config/rembric/bin/`
- **AND** the canonical command SHALL be reachable from `README.md::Supported agents`, `docs/agents.md::opencode`, and the per-client README

#### Scenario: GitHub UI also 404s on legacy paths

- **WHEN** a user opens `https://github.com/susomejias/rembric/blob/main/plugin/.hermes-plugin/install.sh` in a browser
- **THEN** GitHub SHALL render its standard "file not found" page (not a stub file)
- **AND** the `apps/plugin/.hermes-plugin/install.sh` URL SHALL render the canonical installer

## MODIFIED Requirements

### Requirement: The README MUST accurately describe the current distribution model

`README.md` SHALL describe Rembric's current distribution and install path without referencing distribution mechanisms that have been removed. References to "npm package", "operator CLI", or any other deprecated install mechanism SHALL NOT appear in the README. The README SHALL link to `docs/backup.md` from a prominent install-or-quickstart-adjacent section. The README SHALL link to `SECURITY.md` from the same nav header as `Contributing`.

The README's plugin install URLs SHALL point at `https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.<client>-plugin/install.sh` for the curl-pipe-sh clients (Hermes, opencode), and at `https://github.com/susomejias/rembric` for the marketplace-driven clients (Claude Code, Codex CLI — both consumed via `<client> plugin marketplace add <repo-url>`). The legacy `plugin/.<client>-plugin/install.sh` URLs SHALL NOT appear in the README; the README's table of supported agents SHALL only show the canonical `apps/plugin/...` URLs.

#### Scenario: README stale-claim regression

- **WHEN** a PR re-introduces phrases like "One npm package", "operator CLI", or anchors to removed sections like `#cli-operations`
- **THEN** a CI check or invariant test SHALL flag the regression, OR the reviewer SHALL block the PR with a reference to this requirement

#### Scenario: README structural elements

- **WHEN** a third party loads the README on GitHub
- **THEN** the page SHALL contain (in order): logo / banner, tagline mentioning Docker as the canonical distribution, anchor nav including links to architecture / quickstart / contributing / SECURITY, a clear "Data and your responsibility" section once `add-data-protection-defaults` lands, and a footer linking to LICENSE and CODE_OF_CONDUCT

#### Scenario: README plugin install URLs point at apps/plugin

- **WHEN** a third party copies the install command for a curl-pipe-sh client (Hermes or opencode) from the README
- **THEN** the URL SHALL begin with `https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/`
- **AND** the URL SHALL NOT begin with `https://raw.githubusercontent.com/susomejias/rembric/main/plugin/` (legacy form, now returns HTTP 404)

### Requirement: The repository's release identity MUST be consistent across surfaces

The repo's release identity is multi-component. The version declared in EACH component's manifest SHALL match the version that release-please last set there, AND SHALL match the most recent component-prefixed git tag for that component, AND SHALL match the value reported by the relevant runtime surface for that component:

- `apps/server/package.json::version` ⟷ the most recent `server-vX.Y.Z` git tag ⟷ `GET /healthz` body `version` field ⟷ `ghcr.io/susomejias/rembric:<X.Y.Z>` image tag.
- `apps/plugin/.claude-plugin/plugin.json::version` ⟷ the most recent `claude-code-vX.Y.Z` git tag.
- `apps/plugin/.codex-plugin/plugin.json::version` ⟷ the most recent `codex-vX.Y.Z` git tag.
- `apps/plugin/.hermes-plugin/plugin.yaml::version` ⟷ the most recent `hermes-vX.Y.Z` git tag.
- The `// @rembric-plugin-version` comment in `apps/plugin/.opencode-plugin/plugin.ts` ⟷ the most recent `opencode-vX.Y.Z` git tag.

`release-please` SHALL be the single source of truth for bumping these — `.release-please-manifest.json` carries the authoritative versions and the corresponding `extra-files` updaters synchronize the surfaces on each release PR.

The legacy `vX.Y.Z` tags (pre-restructure) SHALL be retained in git history for image-pull compatibility (`ghcr.io/susomejias/rembric:v0.17.0` MUST remain pullable) but SHALL NOT be created or updated by release-please going forward.

#### Scenario: Server version drift

- **WHEN** any of the four server-side surfaces (`apps/server/package.json::version`, manifest entry for `apps/server`, `/healthz`, GHCR tag for a given release) disagree for the same release
- **THEN** the disagreement SHALL be treated as a release-blocking bug; release-please SHALL be the single source of truth for bumping the server in lock-step

#### Scenario: Plugin component version drift

- **WHEN** any plugin component's manifest version disagrees with its most recent component-prefixed git tag (e.g., `apps/plugin/.hermes-plugin/plugin.yaml::version` differs from the latest `hermes-vX.Y.Z`)
- **THEN** the disagreement SHALL be treated as a release-blocking bug
- **AND** release-please's `extra-files` mechanism SHALL be the only writer to those manifest version fields

#### Scenario: Pre-restructure tag continuity

- **WHEN** an operator pulls `ghcr.io/susomejias/rembric:v0.17.0` after the restructure flip
- **THEN** the image SHALL remain pullable from GHCR even though release-please no longer cuts `vX.Y.Z` tags; the image is treated as an unmaintained historical artifact tied to the pre-restructure release line
