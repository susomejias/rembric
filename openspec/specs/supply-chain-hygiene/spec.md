# supply-chain-hygiene Specification

## Purpose

Owns the dependency threat model: what a third-party package is allowed to do to this repo, and when.

Five knobs, all default-deny or default-refuse, plus the governance that keeps them that way. Lifecycle scripts do not run unless a package is explicitly allowlisted, and that allowlist's membership is pinned by an executable inventory rather than by prose. Transitive dependencies must come from the registry — git URLs and arbitrary tarballs are refused. New versions must age before they may be installed, so a compromised publish has time to be caught. Installs are frozen against the lockfile, which pins resolution, verifies every tarball's integrity hash, and refuses non-registry sources. Dependency updates arrive as reviewable bot PRs rather than as ad-hoc bumps.

The capability's own rule is that none of these may be weakened without an OpenSpec change recording the decision. It deliberately does NOT own the code that reads them — pnpm does — so every requirement here is a property of tracked configuration, asserted against the file rather than described alongside it.

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

#### Scenario: PR removes ignore-scripts

- **WHEN** a PR proposes deleting `ignore-scripts=true` from `.npmrc` without a corresponding OpenSpec proposal
- **THEN** the change SHALL be rejected
- **AND** the rejecter SHALL link to this requirement and to the relevant section of `.agents/skills/npm-security-best-practices/SKILL.md`

#### Scenario: PR lowers minimumReleaseAge to 0

- **WHEN** a PR proposes lowering `minimumReleaseAge` from `4320` to `0` (effectively disabling cooldown) without a corresponding OpenSpec proposal
- **THEN** the change SHALL be rejected
- **AND** the reviewer SHALL ask whether the intent is a one-shot escape hatch (use per-install `--no-minimum-release-age` instead) or a permanent policy change (which requires the proposal)

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
