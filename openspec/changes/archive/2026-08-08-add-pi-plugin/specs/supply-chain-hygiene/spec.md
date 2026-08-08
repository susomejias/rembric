## ADDED Requirements

### Requirement: Packages this repository publishes MUST carry provenance and be published without a long-lived credential

This capability's existing requirements are inbound: what a third-party package may do to this repo. This requirement is the outbound half, and it exists because the repository now publishes a package of its own (`@rembric/pi`, the Pi client extension) and had no policy covering that at all — nothing required provenance, nothing constrained the publish credential, nothing bounded the tarball.

Every package this repository publishes to a public registry SHALL satisfy all four of the following:

1. **Provenance is mandatory.** The publish SHALL be performed with provenance attestation enabled, so a consumer can verify which workflow, at which commit, produced the tarball. A publish without provenance SHALL be treated as a release-blocking defect, not a cosmetic omission.
2. **The credential is short-lived and workflow-bound.** Publishing SHALL authenticate via trusted-publishing OIDC, with the workflow declaring `permissions: id-token: write`. A long-lived registry token (`NPM_TOKEN` or equivalent) SHALL NOT be stored as a repository or organization secret for publishing purposes. A long-lived token with publish rights is a credential that survives its workflow, can be exfiltrated from any job that can read secrets, and cannot be scoped to a commit — which is precisely what OIDC removes.
3. **Tarball contents are bounded by an allowlist and asserted.** The package manifest SHALL declare a `files` allowlist, and CI SHALL assert `npm pack --dry-run`'s file list against an expected set **before** publishing. Both directions matter: a missing file ships a broken package, and an unintended file ships whatever happened to be in the directory.
4. **A published package declares no lifecycle scripts of its own.** No `prepack`, `prepare`, `prepublishOnly`, `preinstall`, `install`, or `postinstall`. Any file that must be materialised into the package before publish SHALL be produced by an explicit CI step, not by a lifecycle script.

Point 4 is measured, not stylistic. Whether a `prepack` script executes **depends on the working directory of the publish command**, because the project `.npmrc` is resolved from the nearest `package.json`: the repository root's `ignore-scripts=true` does not cover a package published from its own directory, but does cover one published from the root. Verified with both a positive and a negative control. A build step whose execution depends on the invoking directory can silently produce a tarball missing its contents with no error on either side, and the `files` + dry-run assertion is what turns that class of failure into a failed job.

This requirement governs what we publish. It does NOT relax `.npmrc::ignore-scripts=true` or `pnpm-workspace.yaml::allowBuilds`, which govern what we install; nothing in this requirement is a reason to touch either.

#### Scenario: A published package is verifiable

- **WHEN** a consumer inspects a published version of a package this repository owns
- **THEN** the version SHALL carry provenance identifying the publishing workflow and the source commit

#### Scenario: No long-lived publish token exists

- **WHEN** the repository's workflows and configured secrets are audited
- **THEN** no secret whose purpose is registry publish authentication SHALL be present
- **AND** the publishing workflow SHALL declare `permissions: id-token: write` and authenticate via trusted publishing

#### Scenario: A tarball missing a required file fails the job

- **GIVEN** the CI step that materialises a shared resource into the package directory did not run or failed to copy one file
- **WHEN** the asserted `npm pack --dry-run` runs
- **THEN** the job SHALL fail naming the missing path
- **AND** no publish SHALL occur

#### Scenario: An unintended file in the tarball fails the job

- **GIVEN** an untracked or development-only file is present in the package directory at pack time
- **WHEN** the asserted `npm pack --dry-run` runs
- **THEN** the job SHALL fail naming the unexpected path

#### Scenario: A lifecycle script in a published manifest fails the build

- **GIVEN** a package this repository publishes declares any of `prepack`, `prepare`, `prepublishOnly`, `preinstall`, `install`, or `postinstall`
- **WHEN** `pnpm test` runs
- **THEN** an assertion SHALL fail naming the manifest and the offending script key
- **AND** the failure message SHALL state that materialisation belongs in an explicit CI step because lifecycle-script execution depends on the publish command's working directory

### Requirement: A published package's runtime dependency surface MUST be justified, and zero is the default

A package this repository publishes SHALL declare the minimum runtime dependency surface that makes it work, and SHALL prefer zero. Every runtime `dependencies` entry in a published package SHALL be justified in the proposal that introduces it, on the same standard as an `allowBuilds` grant: a dependency we ship executes on a user's machine and is a dependency that user cannot decline.

Host packages that are present by construction (the plugin host of a client extension) SHALL be declared as `peerDependencies` and SHALL NOT be bundled. Their version range SHALL not assert compatibility broader than what has been measured; where only one version has been measured and the host manages its own compatibility, `"*"` is the honest range.

#### Scenario: The published client extension declares no runtime dependencies

- **WHEN** `apps/plugin/.pi-plugin/package.json` is read at HEAD
- **THEN** it SHALL declare no `dependencies`, or an empty `dependencies` object
- **AND** it SHALL declare no `bundledDependencies` / `bundleDependencies`

#### Scenario: Adding a runtime dependency to a published package requires a recorded justification

- **WHEN** a change proposes adding an entry to a published package's `dependencies`
- **THEN** the proposal SHALL state why the dependency cannot be avoided and what it executes on the user's machine
- **AND** a reviewer SHALL block the change if that justification is absent

## MODIFIED Requirements

### Requirement: The supply-chain knobs MUST NOT be weakened without an OpenSpec change

Any change that removes a knob, lowers a numeric threshold, adds a `true` entry to `allowBuilds`, expands `minimumReleaseAgeExclude`, disables `engine-strict`, disables Dependabot, or otherwise weakens the defenses defined in this capability SHALL be rejected unless accompanied by a dedicated OpenSpec proposal documenting the rationale and the new contract. Strengthening a knob (raising the cooldown, removing an allowlist entry, etc.) MAY be done via a one-paragraph proposal modifying this spec.

The **outbound** knobs are covered by the same rule: disabling provenance, introducing a long-lived publish credential, removing a published package's `files` allowlist, dropping the `npm pack --dry-run` assertion, adding a lifecycle script to a published manifest, or adding a runtime dependency to a published package SHALL each be rejected without a dedicated proposal. The asymmetry that makes this stricter than the inbound half is that a publish is not revertible: a bad install can be reinstalled, whereas a published version cannot be withdrawn after 72 hours or once anything depends on it.

#### Scenario: PR removes ignore-scripts

- **WHEN** a PR proposes deleting `ignore-scripts=true` from `.npmrc` without a corresponding OpenSpec proposal
- **THEN** the change SHALL be rejected
- **AND** the rejecter SHALL link to this requirement and to the relevant section of `.agents/skills/npm-security-best-practices/SKILL.md`

#### Scenario: PR lowers minimumReleaseAge to 0

- **WHEN** a PR proposes lowering `minimumReleaseAge` from `4320` to `0` (effectively disabling cooldown) without a corresponding OpenSpec proposal
- **THEN** the change SHALL be rejected
- **AND** the reviewer SHALL ask whether the intent is a one-shot escape hatch (use per-install `--no-minimum-release-age` instead) or a permanent policy change (which requires the proposal)

#### Scenario: PR swaps trusted publishing for a stored token

- **WHEN** a PR proposes replacing the OIDC publish with a stored registry token, or removing `permissions: id-token: write`, without a corresponding OpenSpec proposal
- **THEN** the change SHALL be rejected
- **AND** the reviewer SHALL cite the irreversibility of a publish as the reason the outbound half is not negotiable in a PR
