# supply-chain-hygiene Specification

## Purpose

Owns the supply-chain threat model in both directions: **inbound**, what a third-party package is allowed to do to this repo and when; and **outbound**, what a package this repo publishes is allowed to do to the machines that install it.

The inbound half is five knobs, all default-deny or default-refuse, plus the governance that keeps them that way. Lifecycle scripts do not run unless a package is explicitly allowlisted, and that allowlist's membership is pinned by an executable inventory rather than by prose. Transitive dependencies must come from the registry — git URLs and arbitrary tarballs are refused. New versions must age before they may be installed, so a compromised publish has time to be caught. Installs are frozen against the lockfile, which pins resolution, verifies every tarball's integrity hash, and refuses non-registry sources. Dependency updates arrive as reviewable bot PRs rather than as ad-hoc bumps.

The outbound half opens with the first package this repository publishes (`@rembric/pi`, the Pi client extension) and is deliberately the stricter of the two, for one reason: a publish is not revertible. A bad install can be reinstalled; a published version cannot be withdrawn after 72 hours, nor at any point once something depends on it. So provenance is mandatory, the publish credential is short-lived and workflow-bound (trusted-publishing OIDC, never a stored token), the tarball is bounded by an allowlist asserted before publish, a published manifest declares no lifecycle scripts of its own, and the runtime dependency surface defaults to zero — a dependency we ship is one the user cannot decline.

The two halves govern different files and SHALL NOT be conflated: nothing in the outbound requirements is a reason to touch `.npmrc::ignore-scripts` or `pnpm-workspace.yaml::allowBuilds`, which govern what we install.

The capability's own rule is that none of these may be weakened without an OpenSpec change recording the decision. It deliberately does NOT own the code that reads them — pnpm reads the inbound knobs, the release workflow and the registry the outbound ones — so every requirement here is a property of tracked configuration, asserted against the file rather than described alongside it.

## Requirements

### Requirement: Lifecycle scripts MUST be default-deny with an explicit allowlist

Dependency lifecycle scripts (`preinstall`, `install`, `postinstall`, dependency-side `prepare`) SHALL be default-deny. Under the pinned pnpm 11 that property comes from `pnpm-workspace.yaml::allowBuilds`: a package absent from the map does not run its scripts, and `pnpm install` reports `ERR_PNPM_IGNORED_BUILDS` rather than failing. Exceptions SHALL be declared in `allowBuilds` as an explicit per-package boolean map. A transitive that needs a build step but is not granted SHALL fail to execute its scripts (binary still installs, script skipped).

**`.npmrc::ignore-scripts=true` is NOT what makes dependency scripts default-deny, and this requirement SHALL NOT claim that it is.** Measured against the pinned pnpm 11.1.2 with `esbuild@0.25.10` as the oracle (a JS shim in the tarball, an ELF binary only after its postinstall runs): with `ignore-scripts=true` set and `allowBuilds: {esbuild: true}`, the script **ran**; with no `.npmrc` at all and no `allowBuilds`, pnpm **refused**. The knob is still required — it governs the repository's own scripts and is defence in depth — but the file that grants and denies is `pnpm-workspace.yaml`. The previous wording asserted the reverse and was carried unexamined through three changes.

`pnpm-workspace.yaml::dangerouslyAllowAllBuilds` SHALL NOT be set to `true`. pnpm's `createAllowBuildFunction` honours it before it reads `allowBuilds` at all (`if (opts.dangerouslyAllowAllBuilds) return () => true`), so one line grants every package in the tree **and** overrides every explicit `false` deny. Any CLI equivalent (`--dangerously-allow-all-builds`, `--config.dangerouslyAllowAllBuilds`) SHALL likewise not appear on any `pnpm install` the repository runs. Both SHALL be asserted, because this is the only true bypass of the allowlist and a block-scoped parser of `allowBuilds` cannot see a sibling top-level key.

`pnpm-workspace.yaml::allowBuilds` SHALL be the **sole enumeration** of the allowlist. No requirement in a published spec, and no contributor-facing doc (`README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `docs/**`), SHALL enumerate the allowlist — that is, present a list purporting to be the set of allowlisted packages, or state a count of them — because such a copy has no mechanism keeping it current and has diverged in practice. Prose needing to refer to the allowlist SHALL name `pnpm-workspace.yaml::allowBuilds` as the place to read it.

The scope is deliberately those two categories rather than "the tracked tree". Three kinds of tracked file legitimately contain a list and are out of scope: **archived OpenSpec changes** (`openspec/changes/archive/**`), which are a historical record and would be falsified by editing; **the propose/design artifacts of a change** that argue about the allowlist, which must quote what they analyse to be reviewable; and the vendored **skill reference** at `.agents/skills/npm-security-best-practices/`, whose `allowBuilds` blocks are upstream illustrations of pnpm syntax, not claims about this repo. Two further things are not enumerations: citing a **single** entry as context for some other behaviour (e.g. a scenario predicated on `esbuild: false`), and the pinned inventory required below, whose entire purpose is to be compared against the file and which fails when it disagrees.

Each entry SHALL carry an inline justification on its own line, stating why that package needs (or is explicitly denied) a lifecycle script. A `true` entry means the package gets to run arbitrary code on every contributor's machine and CI runner during install; that is a security-relevant decision and its justification is the record of the decision. A `false` entry documents an explicit deny for a transitive dep that would otherwise be considered for the allowlist. `false` is semantically equivalent to absence — both deny — so a `false` entry exists to record a reviewed judgement, not to add protection.

The repository SHALL use the pnpm 11 key `allowBuilds`. The retired pnpm 10 key `onlyBuiltDependencies` SHALL NOT be **declared as a key** in `pnpm-workspace.yaml`, because pnpm 11 ignores it silently: a rename would deny every allowlisted script with no error, and a revert to it would read as plausible in review. Naming the retired key in a comment that explains the migration is permitted and is not a declaration — the rule is keyed on the YAML key, not on the string, and the assertion SHALL be too.

#### Scenario: New transitive dep with a postinstall script

- **WHEN** a routine dep bump pulls in a transitive dep that declares a `postinstall` script
- **THEN** the script SHALL NOT execute during `pnpm install`
- **AND** the install SHALL complete without error (the package's binaries still install; the script silently skips)
- **AND** the dep is reviewable in `pnpm-lock.yaml` without having modified the developer machine

#### Scenario: Adding a package to the allowlist

- **WHEN** an OpenSpec change proposes adding `<pkg>: true` to `pnpm-workspace.yaml::allowBuilds`
- **THEN** the proposal SHALL document the reason (e.g., "native binding requires postinstall to download prebuilt", "git-hook installer required for developer workflow")
- **AND** the same reason SHALL be recorded as the entry's inline justification in `pnpm-workspace.yaml`
- **AND** the reviewer SHALL verify the package source against a trusted upstream (registry signature, popular maintainer, recent activity)

#### Scenario: Reader audits which packages may execute code at install time

- **WHEN** a reader wants the complete set of packages permitted to run lifecycle scripts
- **THEN** reading `pnpm-workspace.yaml::allowBuilds` SHALL be sufficient — every entry, its boolean, and its justification are present there
- **AND** no published spec requirement and no contributor-facing doc SHALL present a competing list or count of allowlisted packages that could contradict it

### Requirement: Transitive dependencies MUST come from the registry only

The repository SHALL set `pnpm-workspace.yaml::blockExoticSubdeps: true`. `pnpm install` SHALL refuse to resolve any transitive dependency from a non-registry source (git URLs, off-registry tarball URLs) and SHALL error out at install with the offending package and source named. A direct dependency MAY still resolve from a git URL or tarball with explicit operator opt-in, but no transitive can.

#### Scenario: Compromised dep adds a git-URL transitive

- **WHEN** a direct dep update introduces a transitive `"foo": "git+https://attacker.example.com/foo.git"` into `pnpm-lock.yaml`
- **THEN** `pnpm install --frozen-lockfile` SHALL fail with an error naming the offending transitive and its source
- **AND** the failure SHALL surface in CI before any code from the exotic source executes

### Requirement: New dependency versions MUST satisfy an install cooldown

The repository SHALL set `pnpm-workspace.yaml::minimumReleaseAge: 4320` (4320 minutes = 3 days). `pnpm install` SHALL refuse to resolve a dependency version published less than 3 days ago. An escape hatch for genuine security patches exists in two forms:

1. Per-install override: `pnpm install --no-minimum-release-age` (interactive, one-shot).
2. Persistent allowlist: `pnpm-workspace.yaml::minimumReleaseAgeExclude: [<pkg>]` for specific packages whose patches must always be eligible immediately.

#### Scenario: Brand-new compromised publish

- **WHEN** a maintainer-account-compromise publishes a malicious version of a transitive dep less than 3 days ago
- **AND** a Dependabot PR or manual update would otherwise resolve to that version
- **THEN** `pnpm install --frozen-lockfile` SHALL refuse the install
- **AND** the operator SHALL have 3 days of community detection before the version becomes installable

#### Scenario: Urgent security patch within the cooldown

- **WHEN** a CVE fix is published less than 3 days ago and adoption cannot wait
- **THEN** the operator MAY either lower `minimumReleaseAge` temporarily in a single PR (and restore in a follow-up), or add the specific package to `minimumReleaseAgeExclude`
- **AND** the change SHALL be reflected in the change history (commit message or proposal) so future reviewers see the deviation

### Requirement: CI and Dockerfile MUST install with a frozen lockfile

The repository SHALL invoke `pnpm install --frozen-lockfile` in:

- `.github/workflows/ci.yml` (the `test` job's Install step).
- `apps/server/Dockerfile` `builder` stage.
- `apps/server/Dockerfile` `dev` stage.

`--frozen-lockfile` SHALL enforce three independent invariants in a single step:

1. `pnpm-lock.yaml` matches `package.json` (no silent lockfile updates).
2. Every tarball's integrity hash matches what the lockfile claims (defends against URL swap + content tampering).
3. `blockExoticSubdeps` refuses non-registry transitive sources.

This combination covers the lockfile-injection threat class (practice #5 of `lirantal/npm-security-best-practices`) for pnpm. `lockfile-lint@4.x` MAY NOT be used as a substitute — it does not parse `pnpm-lock.yaml`.

#### Scenario: PR edits pnpm-lock.yaml without updating package.json

- **WHEN** a PR modifies `pnpm-lock.yaml` (e.g., swapping a tarball URL or removing a checksum) without a corresponding `package.json` change
- **THEN** the CI `Install` step SHALL fail
- **AND** the failure message SHALL identify the divergence (lockfile vs package.json, or integrity-hash mismatch)

#### Scenario: Docker build with stale lockfile

- **WHEN** a Dockerfile builds with a `pnpm-lock.yaml` that disagrees with `package.json`
- **THEN** the `pnpm install --frozen-lockfile` layer SHALL fail
- **AND** the failure SHALL block image publication (CI's `docker-build-check` job catches this before release)

### Requirement: The Node engine constraint MUST be enforced at install time

The repository SHALL set `.npmrc::engine-strict=true`. `pnpm install` SHALL refuse to install when the active Node version does not satisfy `package.json::engines.node`. The current floor is Node `>=22.13` (pnpm 11 imports the `node:sqlite` builtin, which is unavailable on earlier Node minor versions).

#### Scenario: Local install on Node <22.13

- **WHEN** a contributor runs `pnpm install` with Node `<22.13` (e.g., 22.12 or 20.x)
- **THEN** the install SHALL fail immediately with a clear error naming the engine constraint
- **AND** the contributor SHALL NOT see the install succeed and crash later at first `node:sqlite` import

#### Scenario: CI and Docker remain compatible

- **WHEN** CI runs `pnpm install` via `actions/setup-node@v6 with node-version: '22'`
- **AND** the Dockerfile stages install via `FROM node:22-bookworm-slim`
- **THEN** both environments SHALL satisfy `engines.node >= 22.13` and install SHALL succeed

### Requirement: Routine dependency updates MUST be bot-driven under manual review

The repository SHALL contain `.github/dependabot.yml` configuring Dependabot for three ecosystems: `npm` (root), `docker` (`apps/server/`), and `github-actions` (root). All three SHALL be scheduled `weekly` with `open-pull-requests-limit: 5` per ecosystem. Dependabot SHALL NOT be configured for automerge in this file; every PR SHALL require manual review and merge.

Additionally, the repository SHALL have **Dependabot security updates** and **Dependency graph** enabled via the GitHub repository Settings → Security & analysis page. These toggles produce per-CVE PRs from the GitHub Advisory Database, complementing the routine version-update PRs from `dependabot.yml`. They are not file-versioned but are part of the supply-chain contract.

A separate scheduled workflow running `pnpm audit` is NOT required, because Dependabot security updates consume the same advisory database and produce actionable remediation PRs rather than just findings.

#### Scenario: Routine patch bump

- **WHEN** a direct dep publishes a patch release at least 3 days ago
- **THEN** Dependabot SHALL open a PR within the next weekly cycle
- **AND** the PR SHALL NOT be auto-merged
- **AND** the operator SHALL review and merge manually after CI passes

#### Scenario: CVE against a pinned version

- **WHEN** GitHub Advisory Database publishes a CVE affecting a version pinned in `pnpm-lock.yaml`
- **AND** Dependabot security updates are enabled in repo Settings
- **THEN** Dependabot SHALL open a security update PR with the proposed remediation bump
- **AND** the PR SHALL be labelled to distinguish it from routine version updates

#### Scenario: Dockerfile base image bump

- **WHEN** `node:22-bookworm-slim` ships a new minor (security patches in the base image)
- **THEN** the `docker` ecosystem entry SHALL trigger a PR within the next weekly cycle
- **AND** the PR SHALL update the `FROM` directive(s) in `apps/server/Dockerfile`

#### Scenario: GitHub Actions version bump

- **WHEN** a pinned action (`actions/checkout@vX`, `docker/build-push-action@vX`, etc.) ships a new patch or minor within the pinned major
- **THEN** the `github-actions` ecosystem entry SHALL trigger a PR within the next weekly cycle
- **AND** the PR SHALL update the action reference in `.github/workflows/*.yml`

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

### Requirement: The allowlist's `true` membership MUST be pinned by an executable inventory

The set of packages set to `true` in `pnpm-workspace.yaml::allowBuilds` SHALL be pinned in a tracked inventory module, and an executable assertion that runs in `pnpm test` SHALL fail whenever the pinned set and the parsed file disagree, in either direction. The requirement names no file path: which module hosts the assertion is an implementation choice, and pinning it here would make relocating it an archive-gated spec edit. Granting a new package install-time code execution therefore cannot land without an accompanying edit to the inventory, which is the reviewable artifact the governance requirement ("The supply-chain knobs MUST NOT be weakened without an OpenSpec change") depends on. Removing a grant SHALL also fail until the pin is updated, so the inventory can never claim a grant that no longer exists.

`false` membership SHALL NOT be pinned. Only `true` grants execution; a `false` entry is a documented deny, strictly no weaker than the package's absence, and pnpm surfaces newly-flagged transitives as the tree moves — requiring a test edit per deny would be friction with no security effect.

Every entry SHALL be asserted to carry a non-empty inline justification comment, `true` and `false` alike. The assertion SHALL check that a justification is present; it SHALL NOT compare its wording, so that the reason exists in exactly one place.

Every `true` entry SHALL be asserted to resolve to a package present in `pnpm-lock.yaml`. An exception that outlives its dependency grants nothing while the package is absent and silently re-grants execution if the package returns as somebody's transitive, with no reviewer looking at that line when it becomes live again.

The parser SHALL fail closed: any line inside the `allowBuilds` block that it cannot classify as `<name>: <boolean> # <justification>` SHALL fail the test naming the offending line, never be skipped. The assertions SHALL additionally require a non-empty parse and a non-zero `true` count, so that a parse which silently yields nothing cannot satisfy every set comparison vacuously.

#### Scenario: A new native dependency is allowlisted without updating the pin

- **GIVEN** a contributor adds `<pkg>: true` to `pnpm-workspace.yaml::allowBuilds`
- **WHEN** `pnpm test` runs (locally, on pre-push, or in CI)
- **THEN** the invariant SHALL fail, naming `<pkg>` as present in the file but absent from the pinned inventory
- **AND** the failure message SHALL state that granting install-time code execution requires an OpenSpec change against `supply-chain-hygiene`

#### Scenario: An allowlisted package's dependency is removed but its exception is kept

- **GIVEN** a `true` entry names a package that no longer appears anywhere in `pnpm-lock.yaml`
- **WHEN** `pnpm test` runs
- **THEN** the invariant SHALL fail, naming the entry as dead exception surface
- **AND** the fix SHALL be to remove the entry from both `pnpm-workspace.yaml` and the pinned inventory

#### Scenario: An entry is added with no justification

- **GIVEN** a line `<pkg>: true` in the `allowBuilds` block with no trailing comment, or with a comment containing no text
- **WHEN** `pnpm test` runs
- **THEN** the invariant SHALL fail, naming the entry as lacking a justification

#### Scenario: The `allowBuilds` block syntax changes shape

- **GIVEN** a line inside the `allowBuilds` block that is neither blank, nor a comment, nor `<name>: <true|false>` optionally followed by a comment
- **WHEN** `pnpm test` runs
- **THEN** the invariant SHALL fail, quoting the offending line
- **AND** the invariant SHALL NOT pass by skipping the line

#### Scenario: The retired pnpm 10 key reappears

- **GIVEN** `pnpm-workspace.yaml` declares `onlyBuiltDependencies:` as a key, whether alongside `allowBuilds` or in place of it
- **WHEN** `pnpm test` runs
- **THEN** the invariant SHALL fail, stating that pnpm 11 ignores that key and every allowlisted lifecycle script would be silently denied
- **AND** a comment merely naming the retired key SHALL NOT fail the invariant, so the migration can stay documented where it happened

### Requirement: Packages this repository publishes MUST carry provenance and be published without a long-lived credential

This capability's existing requirements are inbound: what a third-party package may do to this repo. This requirement is the outbound half, and it exists because the repository now publishes a package of its own (`@rembric/pi`, the Pi client extension) and had no policy covering that at all — nothing required provenance, nothing constrained the publish credential, nothing bounded the tarball.

The estate is now **two** packages, not one: `@rembric/mcp-bridge` — the stdio↔Streamable-HTTP MCP transport every stdio client spawns — is published from this repository under exactly the same rules. Nothing below is relaxed for it, and nothing below is written around a single package: it publishes with provenance, through trusted-publishing OIDC with no long-lived token, with a `files` allowlist asserted against `npm pack --dry-run` before publish, and with no lifecycle scripts of its own.

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

#### Scenario: A lifecycle script in a published manifest fails the build

- **GIVEN** a package this repository publishes declares any of `prepack`, `prepare`, `prepublishOnly`, `preinstall`, `install`, or `postinstall`
- **WHEN** `pnpm test` runs
- **THEN** an assertion SHALL fail naming the manifest and the offending script key
- **AND** the failure message SHALL state that materialisation belongs in an explicit CI step because lifecycle-script execution depends on the publish command's working directory

#### Scenario: The assertions cover every published package, not one

- **WHEN** the invariant suite enumerates the packages this repository publishes
- **THEN** the enumeration SHALL be derived rather than a single hard-coded manifest path
- **AND** each enumerated package SHALL be checked for provenance-relevant manifest properties (`files` allowlist, absence of lifecycle scripts, absence of `private`)
- **AND** a newly published package that is not covered SHALL fail the suite rather than pass unnoticed

### Requirement: A published package's runtime dependency surface MUST be justified, and zero is the default

A package this repository publishes SHALL declare the minimum runtime dependency surface that makes it work, and SHALL prefer zero. Every runtime `dependencies` entry in a published package SHALL be justified in the proposal that introduces it, on the same standard as an `allowBuilds` grant: a dependency we ship executes on a user's machine and is a dependency that user cannot decline.

Host packages that are present by construction (the plugin host of a client extension) SHALL be declared as `peerDependencies` and SHALL NOT be bundled. Their version range SHALL not assert compatibility broader than what has been measured; where only one version has been measured and the host manages its own compatibility, `"*"` is the honest range.

Where a runtime dependency is unavoidable, three further rules apply:

1. **The version SHALL be exact, never a range.** A range lets a new upstream release change the published package's behaviour on a user's machine with no release of ours — the same hole a floating `npx` tag opens, one level down. An exact version means new third-party code reaches a user only through a deliberate release.
2. **The dependency SHALL NOT be bundled or vendored to make the count look like zero.** A consumer's dependency tree is what lets their advisory tooling see the version they are running; a bundled copy makes a CVE in it invisible to them, and makes the package's behaviour auditable only by reading a build artifact. This repository has paid that cost directly: confirming a dependency's HTTP-status handling required reading its bundled `dist` rather than its dependency tree.
3. **The cost SHALL be measured, not characterised.** The proposal SHALL state the installed package count and size the dependency adds, measured against the alternative it replaces, so the trade is recorded as a number rather than as an adjective.

`@rembric/mcp-bridge` SHALL declare no runtime dependencies, and the reasoning is recorded here because the obvious alternative was specified first and reversed on measurement. Depending on `@modelcontextprotocol/sdk` alone — the protocol's reference implementation, already an `apps/server` dependency and therefore already reviewed and lockfile-pinned here — would have avoided owning any wire protocol. **Measured 2026-08-15** (`npm install --ignore-scripts` into an empty directory): the delegate being replaced, `mcp-remote@0.1.38`, installs 80 packages / 7.0 MB, while `@modelcontextprotocol/sdk` installs 93 packages / 25 MB at `1.29.0` (97 / 24 MB at `1.30.0`), because the SDK ships its server-side halves (`express`, `hono`, `cors`, `jose`, `pkce-challenge`, `express-rate-limit`) in `dependencies` even though only the client transport would be imported. A package whose purpose includes reducing what runs on a user's machine cannot install a larger tree than the delegate it removes, so the dependency was dropped rather than accepted.

What the bridge owns instead is bounded, and smaller than the SDK's full surface suggests: newline-delimited stdio framing, `fetch` with a bearer header, and `data:` line parsing on the response stream. It does **not** own SSE resumability or `Last-Event-ID` (this server does not offer resumable streams), nor OAuth, nor the server half of the protocol. `apps/plugin/.pi-plugin/index.ts` already carries the same surface with `dependencies: {}`, and the one mechanism without precedent there — relaying a server-initiated `roots/list` and posting the host's answer back — was measured working before this was settled (`../own-the-mcp-bridge/measurements/gate-arm3-roots-relay.log`).

This is not vendoring. Bundling a third-party package to report zero dependencies hides the version from a consumer's advisory tooling, which is how confirming `mcp-remote`'s `404` behaviour required reading `chunk-65X3S4HB.js` instead of a dependency tree. First-party code carries no such blind spot: there is no upstream version for tooling to miss.

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
