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

### Requirement: The repository MUST provide structured issue and pull request templates

`.github/ISSUE_TEMPLATE/` SHALL contain at minimum a `bug.md` (or `bug.yml`) and `feature.md` (or `feature.yml`) template, plus a `config.yml` that disables blank issues and routes "I have a question" to GitHub Discussions if Discussions are enabled. `.github/PULL_REQUEST_TEMPLATE.md` SHALL exist with a checklist mirroring `CONTRIBUTING.md::Pull request checklist`.

The bug template's `Client` field SHALL offer a distinct option for **every** bundled plugin client, alongside its non-client options (`Other MCP client`, `Dashboard only`, `Server-side / no client involved`, `N/A`). This requirement SHALL NOT enumerate the bundled clients or state how many there are: membership is owned by the `development-environment` capability's `apps/plugin/` description, and a list frozen here is a list that goes stale on the next client. The obligation is per-client coverage, not a literal roster.

The field is `required: true`, so a bundled client missing from it does not degrade gracefully — a reporter using that client MUST select `Other MCP client`, which files a first-class client as a third-party one on every report and corrupts the only structured signal the maintainer has about which client a defect belongs to. `opencode` was absent from May 2026, and `Pi` from its introduction, for exactly this reason: nothing pinned the list to the client set.

#### Scenario: Issue template surfaces in the new-issue UI

- **WHEN** a third party clicks "New Issue" on GitHub
- **THEN** they SHALL be presented with at least the "Bug" and "Feature" templates, with required fields including Reproduction steps, Rembric version, and Client

#### Scenario: Every bundled client is selectable in the bug template's Client field

- **WHEN** the `Client` dropdown in `.github/ISSUE_TEMPLATE/bug.yml` is compared against the set of bundled plugin clients declared by the `development-environment` capability's `apps/plugin/` description
- **THEN** the dropdown SHALL contain one option per bundled client
- **AND** a reporter using any bundled client SHALL NOT have to select `Other MCP client` to file a report
- **AND** the dropdown SHALL retain its non-client options (`Other MCP client`, `Dashboard only`, `Server-side / no client involved`, `N/A`)

#### Scenario: PR template surfaces in the PR creation UI

- **WHEN** a third party opens a PR
- **THEN** the PR description field SHALL be pre-populated with the contributor checklist from `.github/PULL_REQUEST_TEMPLATE.md`

### Requirement: The repository MUST NOT include personal-identifying paths in tracked content

Tracked content SHALL NOT include literal references to any maintainer or contributor home directory (e.g., `/Users/<name>/`, `/home/<name>/`, `C:\\Users\\<name>\\`) nor any non-public personal identifier (private email addresses, internal usernames, employer-specific identifiers). Example paths in documentation SHALL use placeholders like `<repo>`, `~/projects/rembric`, or `/path/to/rembric`.

#### Scenario: Personal-path leak

- **WHEN** a file is staged for commit that contains a literal personal home-directory string or a non-public personal identifier
- **THEN** the pre-commit hook OR a CI grep SHALL flag the regression; the contributor SHALL replace the literal with an appropriate placeholder

### Requirement: The repository's release identity MUST be consistent across surfaces

The repo's release identity is **two-component** (`server` + unified `plugin`). The version declared in each component's manifest SHALL match the version release-please last set there, AND the most recent component-prefixed git tag for that component, AND the value reported by the relevant runtime surface:

- `apps/server/package.json::version` ⟷ the most recent `server-vX.Y.Z` git tag ⟷ `GET /healthz` body `version` field ⟷ `ghcr.io/susomejias/rembric:<X.Y.Z>` image tag.
- `apps/plugin/package.json::version` ⟷ the most recent `plugin-vX.Y.Z` git tag. The single `plugin` component covers the WHOLE `apps/plugin/` tree; **all five client carriers share this one version**, kept in sync by the component's `extra-files`: `.claude-plugin/{package,plugin}.json`, `.codex-plugin/{package,plugin}.json`, `.hermes-plugin/plugin.yaml`, the `// @rembric-plugin-version` comment in `.opencode-plugin/plugin.ts`, and `.pi-plugin/package.json`. The last of these is also the version published to npm as `@rembric/pi`, so the npm registry becomes a **sixth** surface the plugin version must agree with.
- `mcp-bridge/package.json::version` ⟷ the same `plugin` version, and so SHALL every operational pinned `@rembric/mcp-bridge@<x.y.z>` specifier in the Claude Code and Codex manifests. The opencode hook and printed snippet are executable carriers checked against that version. These transport carriers join the five client carriers under the one version. `@rembric/mcp-bridge` is published to npm as well, so the sixth surface is the registry entry of **both** published packages rather than of `@rembric/pi` alone.

The bridge's pin is a carrier rather than a hand-maintained constant precisely because it names a package released by the same run: a hand-bumped pin can name a version that was never published, and a carrier cannot.

`release-please` SHALL be the single source of truth for bumping these — `.release-please-manifest.json` carries the authoritative versions and each component's updater (plus the `plugin` component's `extra-files`) synchronizes its surfaces. There is **no `node-workspace` cascade**.

Legacy `vX.Y.Z` tags (pre-restructure) and the frozen per-client tags (`plugin-shared-v*`, `claude-code-plugin-v*`, `codex-plugin-v*`, `opencode-plugin-v*`, `hermes-plugin-v*`) SHALL be retained in git history (`ghcr.io/susomejias/rembric:v0.17.0` MUST remain pullable) but SHALL NOT be created or updated going forward. The unified `plugin-vX.Y.Z` tag line supersedes the per-client lines.

#### Scenario: Server version drift

- **WHEN** any of the four server-side surfaces (`apps/server/package.json::version`, manifest entry for `apps/server`, `/healthz`, GHCR tag for a given release) disagree for the same release
- **THEN** the disagreement SHALL be treated as a release-blocking bug; release-please SHALL be the single source of truth for bumping the server in lock-step

#### Scenario: Plugin version drift

- **WHEN** any plugin carrier disagrees with the unified `plugin` version (the `apps/plugin` manifest entry / the most recent `plugin-vX.Y.Z` tag) — e.g. `.hermes-plugin/plugin.yaml::version`, `.claude-plugin/plugin.json::version`, `.pi-plugin/package.json::version`, `mcp-bridge/package.json::version`, or an operational pinned bridge specifier differs
- **THEN** the disagreement SHALL be treated as a release-blocking bug
- **AND** release-please (the `plugin` component's updater plus its `extra-files`) SHALL be the only writer to those version fields

#### Scenario: All client carriers move together under the plugin version

- **WHEN** the `plugin` component is bumped (by any commit touching `apps/plugin/`)
- **THEN** all carriers — `.claude-plugin/{package,plugin}.json`, `.codex-plugin/{package,plugin}.json`, `.opencode-plugin/plugin.ts` comment, `.hermes-plugin/plugin.yaml`, `.pi-plugin/package.json`, `mcp-bridge/package.json`, and the bridge's pinned specifier — SHALL be updated to the same new version in the same release PR

#### Scenario: The bridge's pin names the version that release publishes

- **WHEN** a plugin release cuts version `X.Y.Z`
- **THEN** every operational bridge specifier SHALL read `@rembric/mcp-bridge@X.Y.Z`
- **AND** the version published to npm for `@rembric/mcp-bridge` in the same workflow run SHALL be `X.Y.Z`

#### Scenario: The published npm version matches the plugin tag

- **WHEN** `@rembric/pi` or `@rembric/mcp-bridge` is published for a given release
- **THEN** the published version SHALL equal the `apps/plugin` manifest entry and the `plugin-vX.Y.Z` tag for that release
- **AND** a mismatch SHALL be treated as a release-blocking bug

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

### Requirement: Release-please MUST run as two independent tracks — `server` and a unified `plugin`

The repository SHALL configure `release-please-config.json` in manifest mode with **exactly two packages** and SHALL declare **no** `node-workspace`, `linked-versions`, or other grouping plugin. `separate-pull-requests` SHALL be `true`.

The two packages:

- `apps/server` — component `server`, `release-type: node`, `package-name: @rembric/server`, `include-component-in-tag: true`. Tag `server-vX.Y.Z`. Releases only when files under `apps/server/` change. Its release is the trigger for the Docker image publish (see the docker-publish requirement, retained).
- `apps/plugin` — component `plugin`, `release-type: node`, `package-name: @rembric/plugin`, `include-component-in-tag: true`. It SHALL cover the **entire** `apps/plugin/` tree (shared assets AND all five client dirs) — it SHALL declare **no** `exclude-paths`. Tag `plugin-vX.Y.Z`. Releases only when files under `apps/plugin/` change; a plugin release SHALL NOT rebuild the server image. A plugin release IS the trigger for the `@rembric/pi` npm publish (see the outbound-publication requirement in `supply-chain-hygiene`).

`apps/plugin/mcp-bridge/` — the published stdio↔Streamable-HTTP transport package — is part of that tree and is therefore covered by the same component under the same **no `exclude-paths`** rule: a commit touching only it releases `plugin`, and a plugin release is equally the trigger for the `@rembric/mcp-bridge` npm publish. It is **not** a third package: the config still declares exactly two, and the two-track model (`server` + unified `plugin`) is unchanged by it.

All five plugin clients SHALL share the single `plugin` version (no per-client independent version). The `plugin` component SHALL update every client version carrier in lock-step via `extra-files`: `apps/plugin/.claude-plugin/plugin.json`, `apps/plugin/.codex-plugin/plugin.json`, the `// @rembric-plugin-version` comment in `apps/plugin/.opencode-plugin/plugin.ts`, `apps/plugin/.hermes-plugin/plugin.yaml`, and `apps/plugin/.pi-plugin/package.json`. Every `extra-files` path SHALL be relative to the component directory and SHALL NOT traverse outside it — a `..` segment is rejected by release-please outright. A leading-slash path, by contrast, is resolved against the repository root and so _can_ name a file outside the component; that mechanism SHALL NOT be used here, and its availability is not the reason for the location. **A client that is also an npm-published package SHALL live inside `apps/plugin/` rather than in `packages/` because release-please attributes a release to a component by the paths of the commits under that component's `path`**: a client directory outside `apps/plugin/` would never itself trigger a `plugin` release, so its carrier would be rewritten only when some unrelated change triggered one — which is precisely the lock-step guarantee this requirement exists to provide.

The transport package SHALL share that same single version, and the `plugin` component's `extra-files` SHALL additionally cover `apps/plugin/mcp-bridge/package.json` and the two manifest pin sites, under the same component-relative constraint (no leading slash, no `..`). The opencode hook and printed snippet are executable carriers checked by invariant rather than release-please text replacement. A pin is a carrier rather than a hand-maintained constant precisely because it names a package released by the same run: a hand-bumped pin can name a version that was never published, and a carrier cannot. The location rule above applies unchanged to a published package that is **not** a client — the attribution mechanism knows nothing about clients, so any package this repository publishes to npm SHALL live inside `apps/plugin/` for the same reason.

The `.release-please-manifest.json` SHALL declare exactly two entries (`apps/server`, `apps/plugin`). A client being published to npm SHALL NOT make it a component: it is a version carrier of `plugin` and nothing more. Git tags produced by release-please SHALL follow `<component>-vX.Y.Z` — only `server-` and `plugin-`. Legacy `vX.Y.Z` and per-client tags (`claude-code-plugin-v*`, `codex-plugin-v*`, `opencode-plugin-v*`, `hermes-plugin-v*`, `plugin-shared-v*`) remain in history but SHALL NOT be created by future runs.

Neither does being published to npm make the transport a component: like the Pi client, it is a version carrier of `plugin` and nothing more.

There SHALL be no cascade and no anchor-tag dependency: with a single plugin component there is no inter-component dependency edge, so a missing tag can never trigger a history re-scan or a phantom cascade bump.

`apps/plugin/CHANGELOG.md` SHALL be the single user-facing changelog for all plugin changes (shared assets and every client). Because all clients share one version, a change scoped to one client bumps the number every other client reports; the CHANGELOG, scoped by conventional commit, is what records which client actually changed.

The transport package is covered by that same changelog: a change scoped to `apps/plugin/mcp-bridge/` bumps the number every client reports, and the conventional-commit scope is what records that the transport — not a client — is what changed.

#### Scenario: A server-only change bumps only server and publishes Docker

- **WHEN** a contributor merges a `feat:`/`fix:` commit touching only files under `apps/server/`
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

### Requirement: Documented operator commands MUST be verified against the published image

The distribution documentation is required to accurately describe the current distribution model. That requirement is presently violated in a way review cannot catch by reading: the README's backup command shells into the container to run `sqlite3`, which does not exist in the distroless runtime stage, so the command fails on every invocation against the artifact users actually run.

Any command the documentation instructs an operator to run inside the container SHALL be verified against the published image, not against a development checkout. When a documented procedure depends on tooling absent from the runtime stage, the documentation SHALL present the mechanism that does work instead.

#### Scenario: A documented in-container command is verified

- **WHEN** the documentation instructs the operator to execute a command inside the running container
- **THEN** that command SHALL succeed against a container started from the published image

#### Scenario: Documentation references the working mechanism

- **WHEN** a backup or restore procedure is documented
- **THEN** it SHALL reference the dashboard snapshot flow or a host-side file copy, and SHALL NOT reference tooling absent from the runtime stage
