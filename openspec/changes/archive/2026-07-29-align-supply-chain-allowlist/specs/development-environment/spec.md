## RENAMED Requirements

- FROM: `### Requirement: The repo MUST pin pnpm via `packageManager` to a version ≥ 10.26 that supports `blockExoticSubdeps`, `minimumReleaseAge`, and the `onlyBuiltDependencies` allowlist`
- TO: `### Requirement: The repo MUST pin pnpm via `packageManager` to a version ≥ 10.26 that supports `blockExoticSubdeps`, `minimumReleaseAge`, and the `allowBuilds` allowlist`

## REMOVED Requirements

### Requirement: The repo MUST ship `.npmrc` setting `ignore-scripts=true` and `pnpm-workspace.yaml` declaring an `allowBuilds` map

**Reason**: Re-added below with the same policy, but one scenario had to be **renamed**: "Fresh `pnpm install` runs only the **three** allowlisted lifecycle scripts" states a count in its own title, which is the defect this change exists to remove — the count was wrong from 2026-06-05 onward. `openspec archive` matches scenarios by header and refuses to drop one, so a `MODIFIED` block cannot rename a scenario; `REMOVED` + `ADDED` is the mechanism this repo already uses for renames (`archive/2026-06-07-rename-session-get-tool`).

**Migration**: None. No behaviour, no configuration and no file changes. The header is also widened, because the requirement now constrains the Dockerfile's two install-time execution channels and the old header described only the two config files. The re-added requirement keeps both scenarios (one retitled), drops the member enumeration and the false "These three are the only…" universal, and replaces the unmet `runtime`-stage `--ignore-scripts` clause with the two image-build channels that are actually asserted.

## ADDED Requirements

### Requirement: The repo MUST ship `.npmrc` setting `ignore-scripts=true`, declare the allowlist in `pnpm-workspace.yaml::allowBuilds`, and constrain both image-build execution channels

The repo SHALL contain a root-level `.npmrc` whose contents include `ignore-scripts=true`, and a root-level `pnpm-workspace.yaml` declaring `allowBuilds`. Under the pinned pnpm 11 these do different jobs, and this requirement SHALL keep them distinct: `allowBuilds` is what makes DEPENDENCY lifecycle scripts default-deny (a package absent from the map does not run them), while `ignore-scripts=true` governs the repository's own scripts and is defence in depth. `ignore-scripts=true` does NOT suppress a package that `allowBuilds` grants — measured, see `supply-chain-hygiene`. Both files SHALL therefore reach every context that installs: developer workstation, CI runner, and each Dockerfile stage that runs `pnpm install`.

The installing stages are named by the assertion below rather than by this prose, because a previous version named "both the dev stage and the runtime stage" and both halves were wrong: the `runtime` stage is distroless and runs no `pnpm install` at all, while `builder` — the stage whose output actually ships — was not named.

The repo SHALL contain a root-level `pnpm-workspace.yaml` whose contents include an `allowBuilds:` per-package boolean map, each of whose entries carries an inline justification. `true` entries are packages permitted to execute lifecycle scripts (git-hook installers such as Husky's `prepare`, and native bindings whose postinstall places a platform-specific prebuilt binary); `false` entries are explicit denies recorded for transitives that pnpm flags during install. Any future dependency that requires a postinstall SHALL be added to `allowBuilds` with `true` explicitly and reviewed in a PR.

**This requirement SHALL NOT enumerate the allowlist's members or state how many there are.** Membership is owned by the `supply-chain-hygiene` capability, whose contract makes `pnpm-workspace.yaml::allowBuilds` the sole enumeration and pins the `true` set with an executable inventory. A previous version of this requirement enumerated a subset of the `true` entries and asserted that they were "the only third-party lifecycle scripts the repo permits to run"; a further entry was allowlisted on 2026-06-05 and the claim shipped false for dozens of releases. The specifics are recorded in the `align-supply-chain-allowlist` change rather than here, so this requirement does not freeze a release count that only grows.

The legacy `package.json::pnpm.onlyBuiltDependencies` field SHALL NOT be present in any workspace manifest — pnpm 11 reads the allowlist from `pnpm-workspace.yaml::allowBuilds`, so a surviving legacy field would split the source of truth. Note: pnpm 10.x uses a different syntax (`onlyBuiltDependencies:` as a list). Both syntaxes are documented in the skill at `.agents/skills/npm-security-best-practices/references/pnpm-config.md`; the repo SHALL use the pnpm 11 `allowBuilds:` map since `package.json::packageManager` pins pnpm 11.

The image build has two install-time code-execution channels, and both SHALL be asserted executably, because a static check on `allowBuilds` alone is blind to either:

1. **`pnpm install`.** Every Dockerfile stage that runs `pnpm install` SHALL `COPY` both `pnpm-workspace.yaml` and `.npmrc` into that stage **before** the install line. Neither file reaches an image except by being copied in, each stage copies independently, and a COPY that lands after the install cannot have governed it — so the assertion SHALL be ordinal, not a presence test. `pnpm-workspace.yaml` is the load-bearing one: without it in the ancestor chain the stage installs under a policy nobody reviewed. No stage SHALL pass a dangerously-allow-all-builds flag.
2. **`pnpm rebuild <pkg…>`.** Its explicit argument list SHALL be a subset of the pinned `true` set, and a `pnpm rebuild` with no package arguments SHALL fail the assertion because it makes the subset check vacuous. Measured honestly: pnpm 11.1.2 **does** respect `allowBuilds` here — `pnpm rebuild esbuild` with esbuild ungranted left the shim untouched — so this is a guard, not a live hole. It is asserted anyway because a rebuild argument is the shape a grant would take if that behaviour ever changed, and because the flag check above has to cover rebuild lines too.

A previous version of this requirement instead demanded that "the Dockerfile's `runtime` stage retain `--ignore-scripts` on its `pnpm install` line" with an inline comment referencing the policy. That clause was false in two ways for as long as it was published: the `runtime` stage runs no `pnpm install`, and neither install that does exist carried the flag or the comment. It is replaced rather than repaired because the flag governs the wrong thing (see above), and because it drew attention to a channel that was already covered while saying nothing about the one bypass that actually defeats the allowlist.

#### Scenario: Fresh `pnpm install` runs only the allowlisted lifecycle scripts

- **GIVEN** a clean clone of the repo with no `node_modules/`
- **WHEN** the contributor runs `pnpm install`
- **THEN** the install SHALL complete successfully
- **AND** the only dependency lifecycle scripts that execute SHALL be those of packages set to `true` in `pnpm-workspace.yaml::allowBuilds`
- **AND** `.husky/_/` SHALL be populated (verified by triggering a no-op `git commit` and observing the `pre-commit` hook fire)
- **AND** every native binding whose entry is `true` SHALL be loadable — each verified by requiring it, including the in-process embedder's runtime, not only the SQLite bindings whose omission is what let the previous enumeration rot

#### Scenario: Adding a dep that wants a postinstall surfaces in code review

- **GIVEN** a contributor opens a PR adding a dependency whose `package.json` declares a `postinstall` script
- **WHEN** another contributor reviews the PR
- **THEN** the new dep SHALL fail to execute its postinstall under the repo's policy
- **AND** the diff SHALL require an accompanying edit to `pnpm-workspace.yaml::allowBuilds` for the script to run
- **AND** that edit SHALL be visible to reviewers as a separate, auditable line in the PR
- **AND** the edit SHALL additionally require updating the pinned inventory required by `supply-chain-hygiene`, so the grant cannot land without a second reviewable line
