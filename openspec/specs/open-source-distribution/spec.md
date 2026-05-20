# open-source-distribution Specification

## Purpose

Codifies the durable requirements for Rembric as a publicly distributed open-source project: license shape, vulnerability disclosure policy, code of conduct, README presentation invariants, contributor on-ramp documents, the no-personal-leak rule for tracked content, the release-identity contract across version surfaces, and the post-rewrite recoverable backup branch. These requirements are enforced from the moment the repository becomes publicly accessible; any change that weakens or removes them MUST go through a dedicated OpenSpec proposal.

## Requirements

### Requirement: The project MUST ship under an OSI-approved license

The repository root SHALL contain a `LICENSE` file declaring an OSI-approved license. The copyright line SHALL reference "Rembric contributors" rather than any single legal name to keep the project welcoming to future contributors.

#### Scenario: License inspection

- **WHEN** a third party inspects the repository
- **THEN** `LICENSE` SHALL be present at the repository root, SHALL be readable, SHALL declare an OSI-approved license (currently MIT), and SHALL contain the copyright line "Copyright (c) <year> Rembric contributors"

#### Scenario: License removal or replacement

- **WHEN** a change attempts to remove or replace the `LICENSE` file
- **THEN** the change SHALL be rejected unless it includes a dedicated proposal documenting the rationale, the new license terms, and the impact on existing redistributors

### Requirement: The repository MUST publish a vulnerability disclosure policy

The repository root SHALL contain a `SECURITY.md` file describing how to report security vulnerabilities. The policy SHALL prefer GitHub Security Advisories (`gh security advisory`) as the primary channel and SHALL include an email fallback. The policy SHALL state the maintainer's response time commitment, the supported version window, and explicitly disclaim coordinated disclosure for unsupported versions.

#### Scenario: SECURITY.md presence

- **WHEN** a third party visits the repository on GitHub
- **THEN** the `Security` tab SHALL surface the `SECURITY.md` content, and GitHub SHALL render the "Report a vulnerability" button linked to the Security Advisories flow

#### Scenario: Vuln report received

- **WHEN** a researcher files a Security Advisory via the GitHub UI
- **THEN** the maintainer SHALL acknowledge receipt within 5 business days; if no acknowledgement is received in that window, the researcher MAY use the email fallback documented in `SECURITY.md`

### Requirement: The repository MUST publish a code of conduct

The repository root SHALL contain a `CODE_OF_CONDUCT.md` file based on Contributor Covenant 2.1 (verbatim text or adoption-by-reference both acceptable), with the maintainer's contact email substituted into the enforcement section. Enforcement reports SHALL be directed to the same email address documented in `SECURITY.md` or a clearly distinct one — the policy SHALL state which.

#### Scenario: CODE_OF_CONDUCT.md presence

- **WHEN** a contributor opens a PR
- **THEN** the GitHub PR creation flow SHALL surface a link to `CODE_OF_CONDUCT.md`, and the file SHALL be discoverable from the repository's About sidebar

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

### Requirement: The repository MUST provide structured issue and pull request templates

`.github/ISSUE_TEMPLATE/` SHALL contain at minimum a `bug.md` (or `bug.yml`) and `feature.md` (or `feature.yml`) template, plus a `config.yml` that disables blank issues and routes "I have a question" to GitHub Discussions if Discussions are enabled. `.github/PULL_REQUEST_TEMPLATE.md` SHALL exist with a checklist mirroring `CONTRIBUTING.md::Pull request checklist`.

#### Scenario: Issue template surfaces in the new-issue UI

- **WHEN** a third party clicks "New Issue" on GitHub
- **THEN** they SHALL be presented with at least the "Bug" and "Feature" templates, with required fields including Reproduction steps, Rembric version, and Client (Claude Code / Codex CLI / Hermes Agent)

#### Scenario: PR template surfaces in the PR creation UI

- **WHEN** a third party opens a PR
- **THEN** the PR description field SHALL be pre-populated with the contributor checklist from `.github/PULL_REQUEST_TEMPLATE.md`

### Requirement: The repository MUST NOT include personal-identifying paths in tracked content

Tracked content SHALL NOT include literal references to any maintainer or contributor home directory (e.g., `/Users/<name>/`, `/home/<name>/`, `C:\\Users\\<name>\\`) nor any non-public personal identifier (private email addresses, internal usernames, employer-specific identifiers). Example paths in documentation SHALL use placeholders like `<repo>`, `~/projects/rembric`, or `/path/to/rembric`.

#### Scenario: Personal-path leak

- **WHEN** a file is staged for commit that contains a literal personal home-directory string or a non-public personal identifier
- **THEN** the pre-commit hook OR a CI grep SHALL flag the regression; the contributor SHALL replace the literal with an appropriate placeholder

### Requirement: The repository's release identity MUST be consistent across surfaces

The repo's release identity is multi-component. The version declared in EACH component's manifest SHALL match the version that release-please last set there, AND SHALL match the most recent component-prefixed git tag for that component, AND SHALL match the value reported by the relevant runtime surface for that component:

- `apps/server/package.json::version` ⟷ the most recent `server-vX.Y.Z` git tag ⟷ `GET /healthz` body `version` field ⟷ `ghcr.io/susomejias/rembric:<X.Y.Z>` image tag.
- `apps/plugin/.claude-plugin/plugin.json::version` ⟷ the most recent `claude-code-plugin-vX.Y.Z` git tag.
- `apps/plugin/.codex-plugin/plugin.json::version` ⟷ the most recent `codex-plugin-vX.Y.Z` git tag.
- `apps/plugin/.hermes-plugin/plugin.yaml::version` ⟷ the most recent `hermes-plugin-vX.Y.Z` git tag.
- The `// @rembric-plugin-version` comment in `apps/plugin/.opencode-plugin/plugin.ts` ⟷ the most recent `opencode-plugin-vX.Y.Z` git tag.

`release-please` SHALL be the single source of truth for bumping these — `.release-please-manifest.json` carries the authoritative versions and the corresponding `extra-files` updaters synchronize the surfaces on each release PR.

The legacy `vX.Y.Z` tags (pre-restructure) SHALL be retained in git history for image-pull compatibility (`ghcr.io/susomejias/rembric:v0.17.0` MUST remain pullable) but SHALL NOT be created or updated by release-please going forward.

#### Scenario: Server version drift

- **WHEN** any of the four server-side surfaces (`apps/server/package.json::version`, manifest entry for `apps/server`, `/healthz`, GHCR tag for a given release) disagree for the same release
- **THEN** the disagreement SHALL be treated as a release-blocking bug; release-please SHALL be the single source of truth for bumping the server in lock-step

#### Scenario: Plugin component version drift

- **WHEN** any plugin component's manifest version disagrees with its most recent component-prefixed git tag (e.g., `apps/plugin/.hermes-plugin/plugin.yaml::version` differs from the latest `hermes-plugin-vX.Y.Z`)
- **THEN** the disagreement SHALL be treated as a release-blocking bug
- **AND** release-please's `extra-files` mechanism SHALL be the only writer to those manifest version fields

#### Scenario: Pre-restructure tag continuity

- **WHEN** an operator pulls `ghcr.io/susomejias/rembric:v0.17.0` after the restructure flip
- **THEN** the image SHALL remain pullable from GHCR even though release-please no longer cuts `vX.Y.Z` tags; the image is treated as an unmaintained historical artifact tied to the pre-restructure release line

### Requirement: The repository MUST keep a recoverable backup branch for at least 90 days after the public flip

After the orphan-branch swap that opens the project to the public, the pre-rewrite state SHALL be preserved on a branch named `backup-pre-public` pushed to origin. The branch SHALL be protected from force-push and deletion for at least 90 days from the date of the flip. After 90 days, the maintainer MAY remove the branch but SHALL retain a local mirror clone or full-directory backup for at least one calendar year.

#### Scenario: Recovery within 90 days

- **GIVEN** the public flip occurred less than 90 days ago
- **WHEN** the maintainer needs to recover the pre-rewrite history
- **THEN** `git fetch origin backup-pre-public` SHALL succeed and SHALL return the pre-rewrite commit graph in full

#### Scenario: Accidental force-push attempt on backup-pre-public

- **WHEN** any actor attempts `git push --force origin backup-pre-public`
- **THEN** GitHub branch protection rules SHALL reject the push within the 90-day window

### Requirement: Release-please MUST run in multi-component manifest mode with five independent components

The repository SHALL configure `release-please-config.json` in manifest mode with exactly five packages, each tied to a single workspace path:

- `apps/server` — component name `server`, `release-type: node`, `package-name: @rembric/server`, `include-component-in-tag: true`.
- `apps/plugin/.claude-plugin` — component name `claude-code-plugin`, `package-name: @rembric/plugin-claude-code`, `release-type: simple`, `include-component-in-tag: true`, `extra-files: ["plugin.json"]`.
- `apps/plugin/.codex-plugin` — component name `codex-plugin`, `package-name: @rembric/plugin-codex`, `release-type: simple`, `include-component-in-tag: true`, `extra-files: ["plugin.json"]`.
- `apps/plugin/.hermes-plugin` — component name `hermes-plugin`, `package-name: @rembric/plugin-hermes`, `release-type: simple`, `include-component-in-tag: true`, `extra-files: ["plugin.yaml"]`.
- `apps/plugin/.opencode-plugin` — component name `opencode-plugin`, `package-name: @rembric/plugin-opencode`, `release-type: node`, `include-component-in-tag: true`, `extra-files: [{ "type": "generic", "path": "plugin.ts" }]`. The generic updater operates on the `// @rembric-plugin-version <semver>` line because that line is wrapped in `// x-release-please-start-version` / `// x-release-please-end` markers (release-please's standard annotation for updating arbitrary text in non-package files). The `@rembric-plugin-version` marker remains the canonical version source readable by humans and the install script; the `x-release-please-*` wrappers are purely the updater's anchor.

`release-please-config.json` SHALL also declare a `plugins` array containing one `linked-versions` entry with `groupName: "bridge-bundlers"` and `components: ["claude-code-plugin", "codex-plugin"]`. This causes any release-please-eligible commit affecting either component to bump both — modelling the fact that both marketplace consumers extract `apps/plugin/` as a self-contained root and bundle the shared `bin/`, `hooks/`, `commands/`, `scripts/`. `hermes-plugin` and `opencode-plugin` SHALL NOT participate in any linked-versions group because their installers re-fetch from `main` at install time.

The `.release-please-manifest.json` SHALL declare five entries with one initial version per component. The first server release after the restructure SHALL be `server-v0.18.0` (minor bump from the previous `v0.17.0` — semantics unchanged, only layout moved). The four plugin components SHALL each start at the version currently declared in their respective manifests (today `0.8.0`).

Git tags produced by release-please SHALL follow the format `<component>-vX.Y.Z` (e.g., `server-v0.18.0`, `claude-code-plugin-v0.9.0`). The legacy `vX.Y.Z` tags continue to exist in git history but SHALL NOT be created by future release-please runs.

#### Scenario: A commit touching only apps/server bumps only the server component

- **GIVEN** the repo is configured with the 5-component manifest
- **WHEN** a contributor merges a `feat:` commit that modifies only files under `apps/server/`
- **THEN** release-please SHALL open a PR titled with the `server` component name and bumping only `server`'s version
- **AND** the other four components' versions in `.release-please-manifest.json` SHALL remain unchanged

#### Scenario: A commit touching shared plugin code bumps both linked bundlers

- **WHEN** a contributor merges a `feat:` commit that modifies `apps/plugin/bin/rembric-bridge.mjs`
- **THEN** release-please SHALL bump BOTH `claude-code-plugin` and `codex-plugin` components in a single coordinated release PR
- **AND** `hermes-plugin` and `opencode-plugin` versions SHALL remain unchanged
- **AND** both `apps/plugin/.claude-plugin/plugin.json::version` and `apps/plugin/.codex-plugin/plugin.json::version` SHALL be updated via the `extra-files` mechanism

#### Scenario: A Hermes-only fix cuts only a Hermes release

- **WHEN** a contributor merges a `fix:` commit that modifies only `apps/plugin/.hermes-plugin/__init__.py`
- **THEN** release-please SHALL open a release PR bumping only `hermes-plugin`
- **AND** no other component versions SHALL change
- **AND** the resulting tag SHALL be of the form `hermes-plugin-vX.Y.Z`

### Requirement: docker-publish MUST run only when the server component releases

The `.github/workflows/release-please.yml` workflow SHALL gate the `publish-docker` job on the `apps/server` path being present in the release-please-action's `paths_released` output (or whichever equivalent output key the pinned release-please-action version emits). When `apps/server` is NOT in `paths_released`, `publish-docker` SHALL NOT run, even if other components were released in the same workflow invocation.

This SHALL be expressed as a job-level `if:` condition such as `if: ${{ fromJSON(needs.release-please.outputs.paths_released)['apps/server'] != null }}` or equivalent depending on the action's actual output shape.

A `workflow_dispatch` manual override SHALL remain available on `docker-publish.yml` for operator recovery (first-time bootstrap, smoke-test publish of a specific tag) — invoked outside the automatic gate.

#### Scenario: Plugin-only release does not publish Docker

- **GIVEN** a release-please PR is merged that bumps only the `claude-code-plugin` and `codex-plugin` components
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

The directories `plugin/.hermes-plugin/` and `plugin/.opencode-plugin/` SHALL NOT be re-added to the repository tree after the `apps/plugin/` move. Bookmarked old `raw.githubusercontent.com/.../main/plugin/.X-plugin/install.sh` URLs SHALL return HTTP 404. The breakage SHALL be called out as **BREAKING** in the first post-restructure `hermes-plugin-vX.Y.Z` and `opencode-plugin-vX.Y.Z` release notes, and the corrected install command SHALL be discoverable in `README.md`, `docs/agents.md`, and the per-client READMEs at `apps/plugin/.<client>-plugin/README.md`.

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
