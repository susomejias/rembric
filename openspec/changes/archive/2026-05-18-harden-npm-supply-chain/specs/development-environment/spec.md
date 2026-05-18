## ADDED Requirements

### Requirement: The repo MUST pin pnpm via `packageManager` to a version ≥ 10.26 that supports `blockExoticSubdeps`, `minimumReleaseAge`, and the `onlyBuiltDependencies` allowlist

The `package.json::packageManager` field SHALL declare a pnpm version ≥ `10.26.0` (pnpm 10.x or 11.x line) so that all repo install paths — local clones, the CI matrix, both Dockerfile stages, and any downstream tooling that honors corepack — resolve to a pnpm version that natively supports the three supply-chain flags this capability now enforces. The version SHALL be a literal pin (no caret, no tilde) so corepack activates the same binary across every environment. The implementing change pins `pnpm@11.1.2` (the upstream `dist-tags.latest` at the time of merge); future bumps SHALL be reviewed as standalone PRs.

**Node runtime coupling:** pnpm 11 requires Node.js ≥ `22.13`. The repo SHALL declare `package.json::engines.node = ">=22.13"`, AND all three Dockerfile stages (`builder`, `dev`, `runtime`) SHALL use a `node:22-*` base image, AND `.github/workflows/ci.yml`'s `actions/setup-node@v4` step SHALL pin `node-version: '22'`, AND `.devcontainer/devcontainer.json` SHALL use a Node 22 base, AND the repo SHALL ship `.nvmrc` at the root pinning Node `22` (or a specific 22.x) so contributors using `nvm`/`asdf`/`fnm` automatically activate the correct major when entering the repo. Pinning pnpm without bumping every Node install path produces a `Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite` at install time because pnpm 11 imports `node:sqlite` which only exists in Node ≥ 22.

`corepack enable` SHALL be the supported pnpm bootstrap method in CI workflows; `pnpm/action-setup@v4` MAY be used as a wrapper but its `version:` input SHALL be either omitted or set to read from `packageManager`, never hard-coded to a literal that could drift from `package.json`.

#### Scenario: A fresh clone resolves the pinned pnpm version

- **GIVEN** a contributor on a workstation with `corepack` enabled but no pnpm globally installed
- **WHEN** they run `pnpm --version` from the repo root
- **THEN** corepack SHALL fetch and activate the version declared in `package.json::packageManager`
- **AND** the resolved version SHALL be ≥ `10.26.0`

#### Scenario: CI install path resolves to the same pinned version

- **GIVEN** a GitHub Actions runner with the `Install pnpm` step configured to use corepack or `pnpm/action-setup@v4` (without a hard-coded `version:`)
- **WHEN** the workflow runs `pnpm --version` before any install step
- **THEN** the resolved version SHALL match `package.json::packageManager`

### Requirement: The repo MUST ship `.npmrc` setting `ignore-scripts=true` and `pnpm-workspace.yaml` declaring `onlyBuiltDependencies: [husky]`

The repo SHALL contain a root-level `.npmrc` whose contents include `ignore-scripts=true`. This SHALL apply to every `pnpm install` invocation in every context (developer workstation, CI runner, Dockerfile stages — both the dev stage and the runtime stage) and SHALL prevent dependency lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare` when run by a dependency) from executing during installation.

The repo SHALL contain a root-level `pnpm-workspace.yaml` whose contents include an `allowBuilds:` per-package boolean map setting `husky: true`, `better-sqlite3: true`, and `sqlite-vec: true`, with explicit `false` entries for any transitive that pnpm flags during install (initially `esbuild: false`). Husky's `prepare` script registers git hooks; `better-sqlite3` and `sqlite-vec` are native bindings that require postinstall execution to download platform-specific prebuilt binaries. These three are the only third-party lifecycle scripts the repo permits to run; any future dependency that requires a postinstall SHALL be added to `allowBuilds` with `true` explicitly and reviewed in a PR.

The legacy `package.json::pnpm.onlyBuiltDependencies` field (which previously contained `[better-sqlite3, sqlite-vec]` under pnpm 9) SHALL be removed in the same change — pnpm 11 reads the allowlist from `pnpm-workspace.yaml::allowBuilds`, so leaving the legacy field would split the source of truth. Note: pnpm 10.x uses a different syntax (`onlyBuiltDependencies:` as a list). Both syntaxes are documented in the skill at `.agents/skills/npm-security-best-practices/references/pnpm-config.md`; the repo SHALL use the pnpm 11 `allowBuilds:` map since `package.json::packageManager` pins pnpm 11.

The Dockerfile's `runtime` stage SHALL retain `--ignore-scripts` on its `pnpm install` line as defense in depth even though the policy is now redundant via `.npmrc`. An inline comment on the install line SHALL reference the `.npmrc` policy so future readers understand the duplication.

#### Scenario: Fresh `pnpm install` runs only the three allowlisted lifecycle scripts

- **GIVEN** a clean clone of the repo with no `node_modules/`
- **WHEN** the contributor runs `pnpm install`
- **THEN** the install SHALL complete successfully
- **AND** only the lifecycle scripts of `husky`, `better-sqlite3`, and `sqlite-vec` SHALL execute (verified by `pnpm install --reporter=ndjson` output and the absence of unexpected `postinstall` log lines)
- **AND** `.husky/_/` SHALL be populated (verified by triggering a no-op `git commit` and observing the `pre-commit` hook fire)
- **AND** `better-sqlite3` and `sqlite-vec` native bindings SHALL be present under `node_modules/.pnpm/` (verified by `node -e "require('better-sqlite3')(':memory:')"` exiting 0)

#### Scenario: Adding a dep that wants a postinstall surfaces in code review

- **GIVEN** a contributor opens a PR adding a dependency whose `package.json` declares a `postinstall` script
- **WHEN** another contributor reviews the PR
- **THEN** the new dep SHALL fail to execute its postinstall under the repo's policy
- **AND** the diff SHALL require an accompanying edit to `pnpm-workspace.yaml::onlyBuiltDependencies` for the script to run
- **AND** that edit SHALL be visible to reviewers as a separate, auditable line in the PR

### Requirement: `pnpm-workspace.yaml` MUST enforce `blockExoticSubdeps: true` and `minimumReleaseAge: 4320`

The repo's `pnpm-workspace.yaml` SHALL set `blockExoticSubdeps: true` so any transitive dependency whose resolved source is a git URL, a tarball URL, or any non-registry origin SHALL cause `pnpm install` to fail with an error identifying the offending dep. This SHALL apply to every install context (workstation, CI, both Dockerfile stages).

The repo's `pnpm-workspace.yaml` SHALL set `minimumReleaseAge: 4320` (minutes — equivalent to 3 days). `pnpm install` SHALL refuse to install any dependency version published within the last 3 days, surfacing the offending version in the error. The 3-day threshold corresponds to the upstream-recommended default in `npm-security-best-practices` practice #3 and approximates the median time-to-detection for compromised npm publishes.

An escape hatch SHALL exist for genuine security-patch overrides: contributors MAY run `pnpm install --no-minimum-release-age` for a single invocation, OR temporarily lower the threshold in `pnpm-workspace.yaml` and re-tighten in a follow-up PR. The escape hatch SHALL be documented in `CONTRIBUTING.md`.

#### Scenario: Install fails on an exotic transitive source

- **GIVEN** a hypothetical PR introduces a dep `foo@1.0.0` whose `pnpm-lock.yaml` entry points at `git+https://github.com/example/foo.git#abc123`
- **WHEN** CI runs `pnpm install --frozen-lockfile`
- **THEN** pnpm SHALL exit with a non-zero code
- **AND** the error SHALL identify `foo@1.0.0` as the offender and cite `blockExoticSubdeps`

#### Scenario: Install fails on a fresh-publish version

- **GIVEN** a PR bumps a dep to a version published 2 hours ago
- **WHEN** CI runs `pnpm install --frozen-lockfile`
- **THEN** pnpm SHALL exit with a non-zero code citing `minimumReleaseAge`
- **AND** the error SHALL identify the dep + version + the age delta

### Requirement: The repo MUST enforce lockfile integrity through pnpm's native validation chain (integrity hashes + blockExoticSubdeps + frozen-lockfile)

The lockfile-injection attack class (a PR that rewrites lockfile entries to point at attacker-controlled hosts or to bypass checksum validation) SHALL be blocked by three layered pnpm-native defenses, NOT by an external linter. The original plan was to use `lockfile-lint` as a fourth defense, but `lockfile-lint@4.x` does not support `pnpm-lock.yaml` (it only parses npm's `package-lock.json` JSON format and yarn's `yarn.lock`). The three native pnpm defenses cover the same threat model:

- **`pnpm install --frozen-lockfile`** in `.github/workflows/ci.yml` enforces exact lockfile/`package.json` consistency. Any drift (added dep, removed dep, version change) fails the workflow before any tarball is fetched.
- **Integrity hashes** in `pnpm-lock.yaml` are validated against fetched tarball content at install time. Any URL swap that doesn't preserve the original tarball's SHA-512 hash fails the install.
- **`blockExoticSubdeps: true`** in `pnpm-workspace.yaml` refuses transitive deps fetched from git URLs or non-registry tarball URLs, surfacing the offender at install time.

`.github/workflows/ci.yml` SHALL contain an inline comment above the `pnpm install --frozen-lockfile` step explaining the three-defense layering for future readers. The skill `.agents/skills/npm-security-best-practices/SKILL.md` SHALL document `lockfile-lint` under practice #5 as an option for npm-based projects (not pnpm) with a caveat about its pnpm-lock.yaml limitations.

#### Scenario: CI rejects a PR that swaps a tarball URL without changing the integrity hash

- **GIVEN** a PR rewrites a `pnpm-lock.yaml` entry's `resolution.tarball` to `https://attacker.example.com/payload.tgz` but leaves the original `integrity:` hash intact
- **WHEN** `pnpm install --frozen-lockfile` runs in `ci.yml`
- **THEN** pnpm SHALL fetch the URL, compute its SHA-512, observe the mismatch with the lockfile's `integrity:` value, and abort the install with a non-zero exit code
- **AND** the workflow SHALL fail before any further step

#### Scenario: CI rejects a PR that introduces a git-URL transitive dep

- **GIVEN** a PR adds a dep whose `pnpm-lock.yaml` resolution points at `git+https://github.com/example/foo.git`
- **WHEN** `pnpm install --frozen-lockfile` runs in `ci.yml`
- **THEN** `blockExoticSubdeps: true` SHALL cause pnpm to refuse the install with an error identifying the offending dep
- **AND** the workflow SHALL fail before any further step

#### Scenario: CI rejects a PR that desynchronizes the lockfile from `package.json`

- **GIVEN** a PR adds a `dependencies` entry in `package.json` without updating `pnpm-lock.yaml`
- **WHEN** `pnpm install --frozen-lockfile` runs in `ci.yml`
- **THEN** pnpm SHALL exit non-zero with `ERR_PNPM_OUTDATED_LOCKFILE`
- **AND** the workflow SHALL fail before any tarball is fetched

### Requirement: The repo MUST ship a reusable npm-security skill at `.agents/skills/npm-security-best-practices/` with a `.claude/skills/` symlink

The repo SHALL contain `.agents/skills/npm-security-best-practices/` with the following files:

- `SKILL.md` — frontmatter (`name: npm-security-best-practices`, `description:` tuned to fire on dep-addition / install-config / supply-chain review contexts) plus body covering all 17 practices from `https://github.com/lirantal/npm-security-best-practices` in **general** language reusable across any npm-ecosystem project. The body SHALL include concrete commands for npm, pnpm, yarn, and bun where the practice has a package-manager flag. Rembric-specific guidance (the husky allowlist, the 3-day cooldown) SHALL NOT appear in `SKILL.md` itself.
- `references/checklist.md` — one-page summary table of the 17 practices.
- `references/pnpm-config.md` — annotated `.npmrc` and `pnpm-workspace.yaml` snippets with npm/yarn equivalents.
- `references/ci-snippets.md` — copy-pasteable GitHub Actions step examples.
- `references/source.md` — upstream URL, commit SHA snapshot, calendar date of the read, and a reminder to re-read quarterly.

The repo SHALL contain a symlink at `.claude/skills/npm-security-best-practices` pointing to `../../.agents/skills/npm-security-best-practices`, matching the symlink pattern already used for `bun`, `mcp-builder`, `skill-creator`, `plugin-creator`, `plugin-settings`, `plugin-structure`, `rembric-dashboard-ui`, `find-skills`, and `sqlite-database-expert`.

The skill's `description` SHALL trigger on phrases consistent with dep-addition or supply-chain-review intent (e.g., "I want to add express", "review my .npmrc", "should I bump this lockfile?") and SHALL NOT trigger on generic security questions or routine `pnpm install` invocations. Acceptance check: the implementing change's task 6.2 verifies three positive and three negative triggers before merge.

`CONTRIBUTING.md` SHALL contain a section "Adding a dependency" linking to this skill. `CLAUDE.md` SHALL contain a one-line "Supply-chain hygiene" pointer to the skill near the existing "Plugin development discipline" section.

#### Scenario: An agent loads the skill when a contributor proposes adding a dep

- **GIVEN** a contributor opens a chat asking "I want to add `axios` to handle HTTP requests"
- **WHEN** the agent's skill loader scans available skills
- **THEN** `npm-security-best-practices` SHALL be a high-confidence match
- **AND** the agent SHALL surface practice #14 (reduce dep tree — consider `fetch()` instead of axios) and #15 (consult Snyk DB) before recommending the addition

#### Scenario: The skill does NOT load on a generic install command

- **GIVEN** a contributor runs `pnpm install` to refresh `node_modules` after a `git pull`
- **WHEN** the agent's skill loader scans the context
- **THEN** `npm-security-best-practices` SHALL NOT be loaded (no dep-addition signal, no config-edit signal)

### Requirement: The repo MUST ship a `.devcontainer/devcontainer.json` for VSCode / Codespaces isolation

The repo SHALL contain `.devcontainer/devcontainer.json` declaring a containerised development environment that VSCode's Dev Containers extension and GitHub Codespaces consume on "Reopen in Container". The devcontainer SHALL pin the same Node and pnpm versions as the rest of the repo (Node ≥ 20 from `package.json::engines`, pnpm from `package.json::packageManager` via corepack), so a contributor opening the repo in a fresh container gets the same toolchain the host stack produces.

The devcontainer SHALL:

- Use the official `mcr.microsoft.com/devcontainers/typescript-node:22-bookworm` base (or equivalent published Microsoft image pinned to Node 22) so the underlying OS is a known-good Debian variant rather than an ad-hoc image.
- Run `corepack enable && pnpm install` as a `postCreateCommand` so a freshly-created container is ready to develop against without manual steps. The install SHALL honor the repo's `.npmrc` (`ignore-scripts=true`) and `pnpm-workspace.yaml` (allowlist, exotic-block, cooldown) — the security posture established by the prior requirements SHALL NOT be weakened inside the devcontainer.
- Declare runArgs `--security-opt=no-new-privileges:true` and a non-root `remoteUser: node` to limit the blast radius of a malicious `postinstall` script (defense in depth alongside the `ignore-scripts=true` policy from the `.npmrc` requirement).
- Forward host port `8787` so the dashboard remains reachable at `http://127.0.0.1:8787/dashboard` when the contributor runs `pnpm start` inside the devcontainer.

The devcontainer SHALL coexist with the existing `docker-compose.dev.yml` stack: opening the repo in VSCode → "Reopen in Container" produces a dev environment for the LANGUAGE TOOLCHAIN (typecheck, lint, test) while `pnpm run dev:docker:up` continues to be the canonical way to run a SERVER instance. The two paths SHALL NOT collide on host ports (compose dev binds `127.0.0.1:8788`; the devcontainer forwards `8787`).

#### Scenario: VSCode opens the repo in a devcontainer with the toolchain ready

- **GIVEN** a contributor with VSCode + Dev Containers extension installed
- **WHEN** they open the repo folder and invoke "Dev Containers: Reopen in Container"
- **THEN** VSCode SHALL build the container using `.devcontainer/devcontainer.json`
- **AND** the `postCreateCommand` SHALL run `pnpm install` to completion
- **AND** the contributor SHALL be able to run `pnpm test`, `pnpm run typecheck`, and `pnpm run lint` from the integrated terminal without any further setup
- **AND** the running container SHALL operate as the `node` user (not root), verified by `whoami` returning `node`
