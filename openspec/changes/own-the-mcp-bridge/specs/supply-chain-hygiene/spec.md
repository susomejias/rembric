## MODIFIED Requirements

### Requirement: A published package's runtime dependency surface MUST be justified, and zero is the default

A package this repository publishes SHALL declare the minimum runtime dependency surface that makes it work, and SHALL prefer zero. Every runtime `dependencies` entry in a published package SHALL be justified in the proposal that introduces it, on the same standard as an `allowBuilds` grant: a dependency we ship executes on a user's machine and is a dependency that user cannot decline.

Host packages that are present by construction (the plugin host of a client extension) SHALL be declared as `peerDependencies` and SHALL NOT be bundled. Their version range SHALL not assert compatibility broader than what has been measured; where only one version has been measured and the host manages its own compatibility, `"*"` is the honest range.

Where a runtime dependency is unavoidable, three further rules apply:

1. **The version SHALL be exact, never a range.** A range lets a new upstream release change the published package's behaviour on a user's machine with no release of ours — the same hole a floating `npx` tag opens, one level down. An exact version means new third-party code reaches a user only through a deliberate release.
2. **The dependency SHALL NOT be bundled or vendored to make the count look like zero.** A consumer's dependency tree is what lets their advisory tooling see the version they are running; a bundled copy makes a CVE in it invisible to them, and makes the package's behaviour auditable only by reading a build artifact. This repository has paid that cost directly: confirming a dependency's HTTP-status handling required reading its bundled `dist` rather than its dependency tree.
3. **The cost SHALL be measured, not characterised.** The proposal SHALL state the installed package count and size the dependency adds, measured against the alternative it replaces, so the trade is recorded as a number rather than as an adjective.

`@rembric/mcp-bridge` is the first package to declare a runtime dependency, and its justification is recorded here: it depends on `@modelcontextprotocol/sdk` alone, at an exact version, because that package is the protocol's reference implementation, is already an `apps/server` dependency and therefore already reviewed and lockfile-pinned in this repository, and the only alternative is owning the Streamable HTTP wire protocol ourselves — SSE resumability and `Last-Event-ID`, protocol-version negotiation, `DELETE` termination, `202`-vs-stream responses — which is the surface whose mishandling motivated the package. **Measured 2026-08-15** (`npm install --ignore-scripts` into an empty directory): the delegate being replaced, `mcp-remote@0.1.38`, installs 80 packages / 7.0 MB; `@modelcontextprotocol/sdk@1.30.0` installs 97 packages / 24 MB, because the SDK ships its server-side halves (`express`, `hono`, `cors`, `jose`, `pkce-challenge`, `express-rate-limit`) in `dependencies` even though only the client transport is imported. The regression is accepted knowingly and recorded rather than smoothed over.

#### Scenario: The published client extension declares no runtime dependencies

- **WHEN** `apps/plugin/.pi-plugin/package.json` is read at HEAD
- **THEN** it SHALL declare no `dependencies`, or an empty `dependencies` object
- **AND** it SHALL declare no `bundledDependencies` / `bundleDependencies`

#### Scenario: Adding a runtime dependency to a published package requires a recorded justification

- **WHEN** a change proposes adding an entry to a published package's `dependencies`
- **THEN** the proposal SHALL state why the dependency cannot be avoided and what it executes on the user's machine
- **AND** it SHALL state the measured installed package count and size the dependency adds
- **AND** a reviewer SHALL block the change if either is absent

#### Scenario: A ranged runtime dependency fails review

- **GIVEN** a published package declaring a `dependencies` entry whose value carries a range operator (`^`, `~`, `>=`, `*`, or `x`)
- **WHEN** the manifest is read in CI or in review
- **THEN** the change SHALL be rejected
- **AND** the reason SHALL cite that a range lets upstream change user-machine behaviour with no release of ours

#### Scenario: A published package does not bundle its dependency

- **WHEN** the tarball of a package this repository publishes is inspected
- **THEN** it SHALL NOT contain a vendored or bundled copy of a declared dependency
- **AND** it SHALL declare no `bundledDependencies` / `bundleDependencies`

### Requirement: Packages this repository publishes MUST carry provenance and be published without a long-lived credential

This capability's existing requirements are inbound: what a third-party package may do to this repo. This requirement is the outbound half, and it exists because the repository publishes packages of its own — `@rembric/pi` (the Pi client extension) and `@rembric/mcp-bridge` (the stdio↔Streamable-HTTP MCP transport the plugin bridge spawns) — and had no policy covering that at all: nothing required provenance, nothing constrained the publish credential, nothing bounded the tarball.

Every package this repository publishes to a public registry SHALL satisfy all four of the following:

1. **Provenance is mandatory.** The publish SHALL be performed with provenance attestation enabled, so a consumer can verify which workflow, at which commit, produced the tarball. A publish without provenance SHALL be treated as a release-blocking defect, not a cosmetic omission.
2. **The credential is short-lived and workflow-bound.** Publishing SHALL authenticate via trusted-publishing OIDC, with the workflow declaring `permissions: id-token: write`. A long-lived registry token (`NPM_TOKEN` or equivalent) SHALL NOT be stored as a repository or organization secret for publishing purposes. A long-lived token with publish rights is a credential that survives its workflow, can be exfiltrated from any job that can read secrets, and cannot be scoped to a commit — which is precisely what OIDC removes.
3. **Tarball contents are bounded by an allowlist and asserted.** The package manifest SHALL declare a `files` allowlist, and CI SHALL assert `npm pack --dry-run`'s file list against an expected set **before** publishing. Both directions matter: a missing file ships a broken package, and an unintended file ships whatever happened to be in the directory.
4. **A published package declares no lifecycle scripts of its own.** No `prepack`, `prepare`, `prepublishOnly`, `preinstall`, `install`, or `postinstall`. Any file that must be materialised into the package before publish SHALL be produced by an explicit CI step, not by a lifecycle script.

These four SHALL be asserted per package rather than for one package: an assertion written around a single manifest path silently stops covering the estate the moment a second package is published. Every publish step SHALL be gated on the same release-please output that gates the first, so no package can be published by a run that produced no release.

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
- **AND** no publish SHALL occur

#### Scenario: A lifecycle script in a published manifest fails the build

- **GIVEN** a package this repository publishes declares any of `prepack`, `prepare`, `prepublishOnly`, `preinstall`, `install`, or `postinstall`
- **WHEN** the invariant suite runs
- **THEN** the build SHALL fail naming the package and the offending key
- **AND** the failure message SHALL state that materialisation belongs in an explicit CI step because lifecycle-script execution depends on the publish command's working directory

#### Scenario: The assertions cover every published package, not one

- **WHEN** the invariant suite enumerates the packages this repository publishes
- **THEN** the enumeration SHALL be derived rather than a single hard-coded manifest path
- **AND** each enumerated package SHALL be checked for provenance-relevant manifest properties (`files` allowlist, absence of lifecycle scripts, absence of `private`)
- **AND** a newly published package that is not covered SHALL fail the suite rather than pass unnoticed
