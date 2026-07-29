## MODIFIED Requirements

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

## ADDED Requirements

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
