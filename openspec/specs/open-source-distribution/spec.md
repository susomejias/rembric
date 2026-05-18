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

#### Scenario: README stale-claim regression

- **WHEN** a PR re-introduces phrases like "One npm package", "operator CLI", or anchors to removed sections like `#cli-operations`
- **THEN** a CI check or invariant test SHALL flag the regression, OR the reviewer SHALL block the PR with a reference to this requirement

#### Scenario: README structural elements

- **WHEN** a third party loads the README on GitHub
- **THEN** the page SHALL contain (in order): logo / banner, tagline mentioning Docker as the canonical distribution, anchor nav including links to architecture / quickstart / contributing / SECURITY, a clear "Data and your responsibility" section once `add-data-protection-defaults` lands, and a footer linking to LICENSE and CODE_OF_CONDUCT

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

The version declared in `package.json`, the version declared in `.release-please-manifest.json`, and the value reported by `GET /healthz` body's `version` field SHALL agree at all times. Public GHCR image tags SHALL match the git tag that triggered their publish (e.g., `ghcr.io/susomejias/rembric:v0.15.0` is built from the commit tagged `v0.15.0`).

#### Scenario: Version drift

- **WHEN** any of the four surfaces (`package.json`, manifest, `/healthz`, GHCR tag for a given release) disagree
- **THEN** the disagreement SHALL be treated as a release-blocking bug; release-please SHALL be the single source of truth for bumping these in lock-step

#### Scenario: Pre-public tag continuity

- **WHEN** an operator pulls `ghcr.io/susomejias/rembric:v0.14.2` after the public flip
- **THEN** the image SHALL remain pullable from GHCR even though the git tag `v0.14.2` no longer exists in the repository; the image is treated as an unmaintained historical artifact

### Requirement: The repository MUST keep a recoverable backup branch for at least 90 days after the public flip

After the orphan-branch swap that opens the project to the public, the pre-rewrite state SHALL be preserved on a branch named `backup-pre-public` pushed to origin. The branch SHALL be protected from force-push and deletion for at least 90 days from the date of the flip. After 90 days, the maintainer MAY remove the branch but SHALL retain a local mirror clone or full-directory backup for at least one calendar year.

#### Scenario: Recovery within 90 days

- **GIVEN** the public flip occurred less than 90 days ago
- **WHEN** the maintainer needs to recover the pre-rewrite history
- **THEN** `git fetch origin backup-pre-public` SHALL succeed and SHALL return the pre-rewrite commit graph in full

#### Scenario: Accidental force-push attempt on backup-pre-public

- **WHEN** any actor attempts `git push --force origin backup-pre-public`
- **THEN** GitHub branch protection rules SHALL reject the push within the 90-day window
