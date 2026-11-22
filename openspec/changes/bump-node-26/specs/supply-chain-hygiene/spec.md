## MODIFIED Requirements

### Requirement: The Node engine constraint MUST be enforced at install time

The repository SHALL set `.npmrc::engine-strict=true`. `pnpm install` SHALL refuse to install when the active Node version does not satisfy `package.json::engines.node`. The current floor is Node `>=26`, the LTS line every install path runs (the floor pnpm 11 itself needs is `22.13`, because it imports the `node:sqlite` builtin, which is unavailable on earlier Node minor versions).

#### Scenario: Local install on Node <22.13

- **WHEN** a contributor runs `pnpm install` with Node `<22.13` (e.g., 22.12 or 20.x), or with any other version below the `>=26` floor (e.g., 24.x)
- **THEN** the install SHALL fail immediately with a clear error naming the engine constraint
- **AND** the contributor SHALL NOT see the install succeed and crash later at first `node:sqlite` import

#### Scenario: CI and Docker remain compatible

- **WHEN** CI runs `pnpm install` via `actions/setup-node` with `node-version-file: .nvmrc` (Node 26)
- **AND** the Dockerfile's installing stages install via `FROM node:26-trixie-slim`
- **THEN** both environments SHALL satisfy `engines.node >= 26` and install SHALL succeed

### Requirement: Routine dependency updates MUST be bot-driven under manual review

The repository SHALL contain `.github/dependabot.yml` configuring Dependabot for three ecosystems: `npm` (root), `docker` (`apps/web/`), and `github-actions` (root). All three SHALL be scheduled `weekly` with `open-pull-requests-limit: 5` per ecosystem. Dependabot SHALL NOT be configured for automerge in this file; every PR SHALL require manual review and merge.

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

- **WHEN** `node:26-trixie-slim` ships a new minor (security patches in the base image)
- **THEN** the `docker` ecosystem entry SHALL trigger a PR within the next weekly cycle
- **AND** the PR SHALL update the `FROM` directive(s) in `apps/web/Dockerfile`

#### Scenario: GitHub Actions version bump

- **WHEN** a pinned action (`actions/checkout@vX`, `docker/build-push-action@vX`, etc.) ships a new patch or minor within the pinned major
- **THEN** the `github-actions` ecosystem entry SHALL trigger a PR within the next weekly cycle
- **AND** the PR SHALL update the action reference in `.github/workflows/*.yml`
