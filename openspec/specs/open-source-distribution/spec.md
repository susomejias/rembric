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

The README's primary, lead install/upgrade instruction SHALL be the **TUI installer** (the repo-root `install.sh` shim, canonical URL `https://raw.githubusercontent.com/susomejias/rembric/main/install.sh`). The manual Docker quickstart (`curl docker-compose.yml` + `.env.example` + `docker compose up -d`) and the per-client commands SHALL remain in the README only under an explicitly-labelled "Manual / advanced" section, never as the primary path.

When the README does show per-client install URLs (in the manual section), they SHALL point at `https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.<client>-plugin/install.sh` for the curl-pipe-sh clients (Hermes, opencode), and at `https://github.com/susomejias/rembric` for the marketplace-driven clients (Claude Code, Codex CLI — both consumed via `<client> plugin marketplace add <repo-url>`). The legacy `plugin/.<client>-plugin/install.sh` URLs SHALL NOT appear in the README; any per-client URL shown SHALL be the canonical `apps/plugin/...` form.

#### Scenario: README leads with the TUI installer

- **WHEN** a third party reads the README's install/quickstart section top-to-bottom
- **THEN** the first install/upgrade command presented SHALL be the TUI installer (`.../main/install.sh`)
- **AND** the manual Docker quickstart and per-client commands SHALL appear only below, under a heading that marks them as manual / advanced

#### Scenario: README stale-claim regression

- **WHEN** a PR re-introduces phrases like "One npm package", "operator CLI", or anchors to removed sections like `#cli-operations`
- **THEN** a CI check or invariant test SHALL flag the regression, OR the reviewer SHALL block the PR with a reference to this requirement

#### Scenario: README structural elements

- **WHEN** a third party loads the README on GitHub
- **THEN** the page SHALL contain (in order): logo / banner, tagline mentioning Docker as the canonical distribution, anchor nav including links to architecture / quickstart / contributing / SECURITY, a clear "Data and your responsibility" section once `add-data-protection-defaults` lands, and a footer linking to LICENSE and CODE_OF_CONDUCT

#### Scenario: README plugin install URLs point at apps/plugin

- **WHEN** a third party copies a per-client install command (Hermes or opencode) from the README's manual section
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

### Requirement: The repository MUST keep a recoverable backup branch for at least 90 days after the public flip

After the orphan-branch swap that opens the project to the public, the pre-rewrite state SHALL be preserved on a branch named `backup-pre-public` pushed to origin. The branch SHALL be protected from force-push and deletion for at least 90 days from the date of the flip. After 90 days, the maintainer MAY remove the branch but SHALL retain a local mirror clone or full-directory backup for at least one calendar year.

#### Scenario: Recovery within 90 days

- **GIVEN** the public flip occurred less than 90 days ago
- **WHEN** the maintainer needs to recover the pre-rewrite history
- **THEN** `git fetch origin backup-pre-public` SHALL succeed and SHALL return the pre-rewrite commit graph in full

#### Scenario: Accidental force-push attempt on backup-pre-public

- **WHEN** any actor attempts `git push --force origin backup-pre-public`
- **THEN** GitHub branch protection rules SHALL reject the push within the 90-day window

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

### Requirement: Install URL freshness is CI-enforced via static-grep invariant

The repository SHALL include a Vitest invariant test (in `apps/server/src/test/invariants.test.ts`) that fails when any tracked file under `git ls-files` contains the literal substring `raw.githubusercontent.com/susomejias/rembric/main/plugin/` or `github.com/susomejias/rembric/blob/main/plugin/`, **outside an explicit file-path allow-list**. The allow-list SHALL be limited to the spec files that intentionally document the legacy 404 contract:

- `openspec/specs/open-source-distribution/spec.md`
- `openspec/specs/hermes-agent-plugin/spec.md`
- `openspec/specs/opencode-plugin/spec.md`

OpenSpec change directories (`openspec/changes/**`, active and archived) SHALL be excluded by path: they are work-in-progress documents that may legitimately quote the legacy URL while describing the 404 contract; any drift introduced via a change is caught at archive time when the delta merges into the (allow-listed) canonical spec. The test SHALL NOT issue any network request; the assertion is purely substring presence in the working-tree source.

The failure message SHALL name the offending `<file>:<line>` and point the reader at the allow-list location so the regression is self-diagnosing.

#### Scenario: Drift caught in CI

- **WHEN** a contributor opens a PR that adds the substring `raw.githubusercontent.com/susomejias/rembric/main/plugin/` to a tracked file outside the allow-list (for example, a copy-pasted install command in a new markdown file)
- **THEN** the invariant test SHALL fail with a message naming the file and line of the offending occurrence
- **AND** the contributor SHALL either correct the URL to `…/main/apps/plugin/…` or add a justification by extending the allow-list in the same PR

#### Scenario: Intentional spec documentation is not flagged

- **WHEN** the invariant test runs against the current repository state with the three allow-listed spec files containing legacy `main/plugin/` references (documenting the 404 contract)
- **THEN** the test SHALL pass
- **AND** the allow-list SHALL appear once at the top of the test case, alongside a one-line comment identifying each entry as a 404-contract spec

#### Scenario: Test runs offline

- **WHEN** the invariant test executes in a sandbox without network access (the standard `pnpm test` environment)
- **THEN** the test SHALL complete in well under one second
- **AND** no DNS lookup, HTTP request, or filesystem access outside the repository working tree SHALL be issued

### Requirement: The Docker image MUST bundle the embedding model

The published image SHALL contain the pinned ONNX artifacts of the embedding model (`onnx-community/gte-multilingual-base`, q8, pinned revision verified at build time), and the server SHALL run with no model downloads at runtime (`HF_HUB_OFFLINE=1` or equivalent). Both `linux/amd64` and `linux/arm64` builds SHALL be verified in CI, including the native `onnxruntime-node` binding.

#### Scenario: Container starts with no network access to huggingface.co

- **WHEN** the container runs in an air-gapped network and a `memory.save` triggers the first embedding
- **THEN** the model SHALL load from image-local files and inference SHALL succeed with no outbound requests

#### Scenario: Build fails on artifact mismatch

- **WHEN** the build-time model download does not match the pinned revision/checksum
- **THEN** the image build SHALL fail (no silent fallback to a different model)

### Requirement: The README MUST document hardware requirements with their rationale

The README SHALL state the memory floor (minimum 1 GB RAM, recommended 2 GB) and SHALL explain why: the server embeds its semantic engine in-process in exchange for requiring no external services, API keys, or network calls. The model class is pinned (≤350M params, ≤800 MB total process RSS); exceeding it is a breaking architectural change, not a tuning decision.

#### Scenario: A new operator evaluates rembric

- **WHEN** the README's hardware requirements section is read
- **THEN** it SHALL state the 1 GB minimum / 2 GB recommendation, the measured RSS basis, and the zero-external-dependencies trade-off that justifies it
