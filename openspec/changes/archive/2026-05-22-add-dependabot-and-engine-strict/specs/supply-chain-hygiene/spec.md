## ADDED Requirements

### Requirement: Lifecycle scripts MUST be default-deny with an explicit allowlist

The repository SHALL set `.npmrc::ignore-scripts=true` to disable all dependency lifecycle scripts (`preinstall`, `install`, `postinstall`, dependency-side `prepare`) by default during `pnpm install`. Exceptions SHALL be declared in `pnpm-workspace.yaml::allowBuilds:` as an explicit per-package boolean map (pnpm 11+ syntax). The allowlist SHALL be the only place where lifecycle scripts are permitted; transitive dependencies that need a build step but are not on the allowlist SHALL fail to execute their scripts (binary still installs, script silently skipped per pnpm's contract).

The current allowlist values are: `husky: true`, `better-sqlite3: true`, `sqlite-vec: true`, `esbuild: false`. Adding a `true` entry is a security-relevant decision: the package gets to run arbitrary code on every contributor's machine and CI runner during install. Adding a `false` entry documents an explicit deny for a transitive dep that would otherwise be considered for the allowlist.

#### Scenario: New transitive dep with a postinstall script

- **WHEN** a routine dep bump pulls in a transitive dep that declares a `postinstall` script
- **THEN** the script SHALL NOT execute during `pnpm install`
- **AND** the install SHALL complete without error (the package's binaries still install; the script silently skips)
- **AND** the dep is reviewable in `pnpm-lock.yaml` without having modified the developer machine

#### Scenario: Adding a package to the allowlist

- **WHEN** an OpenSpec change proposes adding `<pkg>: true` to `pnpm-workspace.yaml::allowBuilds`
- **THEN** the proposal SHALL document the reason (e.g., "native binding requires postinstall to download prebuilt", "git-hook installer required for developer workflow")
- **AND** the reviewer SHALL verify the package source against a trusted upstream (registry signature, popular maintainer, recent activity)

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
