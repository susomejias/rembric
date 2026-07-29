## RENAMED Requirements

- FROM: `### Requirement: The repo MUST pin pnpm via `packageManager` to a version ≥ 10.26 that supports `blockExoticSubdeps`, `minimumReleaseAge`, and the `onlyBuiltDependencies` allowlist`
- TO: `### Requirement: The repo MUST pin pnpm via `packageManager` to a version ≥ 10.26 that supports `blockExoticSubdeps`, `minimumReleaseAge`, and the `allowBuilds` allowlist`

## MODIFIED Requirements

### Requirement: The repo MUST ship `.npmrc` setting `ignore-scripts=true` and `pnpm-workspace.yaml` declaring an `allowBuilds` map

The repo SHALL contain a root-level `.npmrc` whose contents include `ignore-scripts=true`. This SHALL apply to every `pnpm install` invocation in every context (developer workstation, CI runner, Dockerfile stages — both the dev stage and the runtime stage) and SHALL prevent dependency lifecycle scripts (`preinstall`, `install`, `postinstall`, `prepare` when run by a dependency) from executing during installation.

The repo SHALL contain a root-level `pnpm-workspace.yaml` whose contents include an `allowBuilds:` per-package boolean map, each of whose entries carries an inline justification. `true` entries are packages permitted to execute lifecycle scripts (git-hook installers such as Husky's `prepare`, and native bindings whose postinstall places a platform-specific prebuilt binary); `false` entries are explicit denies recorded for transitives that pnpm flags during install. Any future dependency that requires a postinstall SHALL be added to `allowBuilds` with `true` explicitly and reviewed in a PR.

**This requirement SHALL NOT enumerate the allowlist's members or state how many there are.** Membership is owned by the `supply-chain-hygiene` capability, whose contract makes `pnpm-workspace.yaml::allowBuilds` the sole enumeration and pins the `true` set with an executable inventory. A previous version of this requirement enumerated three `true` entries and asserted "These three are the only third-party lifecycle scripts the repo permits to run"; a fourth (`onnxruntime-node`) was allowlisted on 2026-06-05 and the claim shipped false for 42 releases.

The legacy `package.json::pnpm.onlyBuiltDependencies` field (which previously contained `[better-sqlite3, sqlite-vec]` under pnpm 9) SHALL be removed — pnpm 11 reads the allowlist from `pnpm-workspace.yaml::allowBuilds`, so leaving the legacy field would split the source of truth. Note: pnpm 10.x uses a different syntax (`onlyBuiltDependencies:` as a list). Both syntaxes are documented in the skill at `.agents/skills/npm-security-best-practices/references/pnpm-config.md`; the repo SHALL use the pnpm 11 `allowBuilds:` map since `package.json::packageManager` pins pnpm 11.

The Dockerfile's `runtime` stage SHALL retain `--ignore-scripts` on its `pnpm install` line as defense in depth even though the policy is now redundant via `.npmrc`. An inline comment on the install line SHALL reference the `.npmrc` policy so future readers understand the duplication.

#### Scenario: Fresh `pnpm install` runs only the allowlisted lifecycle scripts

- **GIVEN** a clean clone of the repo with no `node_modules/`
- **WHEN** the contributor runs `pnpm install`
- **THEN** the install SHALL complete successfully
- **AND** the only dependency lifecycle scripts that execute SHALL be those of packages set to `true` in `pnpm-workspace.yaml::allowBuilds`
- **AND** `.husky/_/` SHALL be populated (verified by triggering a no-op `git commit` and observing the `pre-commit` hook fire)
- **AND** every native binding whose entry is `true` SHALL be loadable (verified for the SQLite bindings by `node -e "require('better-sqlite3')(':memory:')"` exiting 0)

#### Scenario: Adding a dep that wants a postinstall surfaces in code review

- **GIVEN** a contributor opens a PR adding a dependency whose `package.json` declares a `postinstall` script
- **WHEN** another contributor reviews the PR
- **THEN** the new dep SHALL fail to execute its postinstall under the repo's policy
- **AND** the diff SHALL require an accompanying edit to `pnpm-workspace.yaml::allowBuilds` for the script to run
- **AND** that edit SHALL be visible to reviewers as a separate, auditable line in the PR
- **AND** the edit SHALL additionally require updating the pinned inventory required by `supply-chain-hygiene`, so the grant cannot land without a second reviewable line
