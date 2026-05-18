## Context

The repo's supply-chain posture today rests on three quiet defenses:

1. `pnpm-lock.yaml` is committed and `--frozen-lockfile` is enforced in `ci.yml` and in both Dockerfile install lines (practice #6, complete).
2. The `runtime` Dockerfile stage uses `pnpm install --frozen-lockfile --prod --ignore-scripts` so the **distributed image** doesn't execute third-party lifecycle scripts at build time.
3. `release-please` controls dep bumps through reviewed PRs, so `pnpm update` is never run blindly (practice #7, complete).

What's missing is the **developer workstation** path. When a contributor clones the repo and runs `pnpm install`, every dep in the tree can execute arbitrary code via `preinstall` / `install` / `postinstall` / `prepare` hooks. Transitive deps can be pulled from git URLs or arbitrary tarball URLs (anything `package.json` accepts as a version spec). Versions published 5 minutes ago — the prime window for supply-chain attacks like the early-2025 `ua-parser-js` compromise or the 2024 `lottie-player` incident — are installed without any delay. And the lockfile itself can be edited by a malicious PR to swap a hash without anyone noticing (lockfile injection, practice #5).

The cheapest fixes to all of this are pnpm config flags. Three of them require pnpm 10.26+ (`blockExoticSubdeps`, `minimumReleaseAge`, the `onlyBuiltDependencies` allowlist format). The repo currently pins `pnpm@9.12.0`. Upgrading pnpm is therefore the **pre-requisite** for adopting practices #1, #2, and #3 in their cleanest form, not an unrelated bump.

The user also wants a **portable** skill — one that documents all 17 practices generically so it can be reused in other repos — distinct from the Rembric-specific enforcement happening in this change. Keeping these concerns separated means the skill stays useful when the upstream practices evolve (new practice added by Liran Tal, an existing one deprecated by a new pnpm feature) without forcing a coupled edit to this repo's config.

## Goals / Non-Goals

**Goals:**

- **Default-deny install scripts.** A fresh `pnpm install` from this repo SHALL run zero third-party lifecycle scripts. Husky is the only explicit exception, declared in `pnpm-workspace.yaml::onlyBuiltDependencies`.
- **Default-deny exotic sources.** Any transitive dep that resolves to a git URL or non-registry tarball SHALL cause `pnpm install` to fail.
- **Install cooldown.** Any dep version younger than 3 days SHALL cause `pnpm install` to fail until either the threshold is met or the dep version is explicitly bumped past the cooldown.
- **Lockfile integrity.** `pnpm-lock.yaml` SHALL be linted in CI before any install step runs. Pull requests that introduce exotic hosts, non-HTTPS URLs, or missing checksums SHALL be rejected at the lint step.
- **Portable skill.** The skill at `.agents/skills/npm-security-best-practices/` SHALL be usable verbatim in any other npm-ecosystem repo. Rembric-specific guidance (the husky allowlist, the specific cooldown threshold) lives in the repo's `pnpm-workspace.yaml` and `CONTRIBUTING.md`, NOT in the skill.

**Non-Goals:**

- Migrating `.env` to a secret manager. The operator confirmed only dev-only tokens are present.
- Adding `.devcontainer/devcontainer.json`. The Docker dev stack covers the same need.
- Pinning specific dependency versions or removing existing deps for #14. The repo is already lean (9 + 18); reduction is an ongoing discipline documented in the skill.
- Setting up `npq` or Socket Firewall as required tools. They're powerful but operator-side; the skill documents them.
- Changing the npm publishing story. The repo is `private: true` and stays that way; practices #11-#13 are documented in the skill and left out of repo config.
- Building a custom static analysis layer over `package.json` diffs. The set of pnpm flags + `lockfile-lint` cover the mechanical detection surface; human review fills the rest.

## Decisions

### Decision 1: Upgrade to pnpm 10.x as the gating prerequisite (Tension A1)

**Rationale:** Practices #1 (#`ignore-scripts` + allowlist), #2 (block exotic sources), and #3 (install cooldown) all have first-class pnpm 10.26+ support via `pnpm-workspace.yaml`. In pnpm 9, the equivalents range from partial (`ignore-scripts` works, but the allowlist syntax is different) to absent (`blockExoticSubdeps` doesn't exist; `minimumReleaseAge` doesn't exist). Carrying three different config dialects (one for pnpm 9, one for npm's `.npmrc`, one for a future `pnpm 10`) is more code review surface than upgrading once and using a single coherent config.

**Risk:** pnpm 10 has known breaking changes vs 9 (notably tightened peer-dep resolution and changes to `node-linker` defaults). The CI matrix (`ci.yml`), the publish workflow (`docker-publish.yml`), and the Dockerfile all do `corepack enable` and rely on `packageManager` in `package.json` to pin the version, so the upgrade is centralised. Task 1.x validates the upgrade end-to-end before any of the new policy flags are added.

**Alternatives considered:**

- _Stay on pnpm 9 + adopt only #1 in its pnpm-9-compatible form (`.npmrc` with `ignore-scripts=true` + manual `pnpm run prepare`)._ Rejected. Loses #2 and #3 entirely, and the husky workflow becomes "the next clone is silently broken until the contributor reads CONTRIBUTING.md and runs prepare manually" — high probability of footgun.
- _Use `@lavamoat/allow-scripts` (Tension A2)._ Rejected. Adds a runtime dep, adds a config file, replaces a feature that pnpm 10 ships natively. Was considered as a fallback if the pnpm 10 upgrade hits unresolvable issues; in that case, re-evaluate.
- _Adopt the practices in two passes (upgrade now, policy flags later)._ Rejected by user preference: bundle in a single change.

### Decision 2: `onlyBuiltDependencies: [husky]` is the single exception

**Rationale:** Husky's `prepare` script registers git hooks at install time. Without it, `pre-commit` / `commit-msg` / `pre-push` go silent and the contracts asserted in `CLAUDE.md` (lint-staged, commitlint, full test run) stop firing — a known footgun the rest of the change is designed to prevent. Listing husky by name in `onlyBuiltDependencies` makes the exception visible and auditable; any future dep that wants a postinstall SHALL be added to this list explicitly, surfacing the choice in code review.

**Trade-off:** A targeted compromise of husky itself would bypass this defense. Husky has 50M+ weekly downloads, an active maintainer, and a 6-year track record; this is the smallest exception we can make and still keep hooks working. The skill documents this as the canonical "if you have husky, list it; otherwise use empty list" pattern.

**Alternatives considered:**

- _Empty allowlist + manual `pnpm run prepare` documented in CONTRIBUTING._ Rejected. Same footgun as Tension A3; new contributors lose hooks silently.
- _Replace husky with a script that doesn't need a postinstall (e.g., a `.git/hooks/` checked-in script or a simpler shell wrapper)._ Out of scope for this change. Possible follow-up if the husky exception ever feels too broad.

### Decision 3: `minimumReleaseAge: 4320` (3 days)

**Rationale:** Three days is the upstream-suggested default in Liran Tal's repo (practice #3) and represents the median time-to-detection for compromised npm publishes based on public incident postmortems (`ua-parser-js`, `event-stream`, `node-ipc`, `colors`). Shorter windows (24h) miss attacks discovered over a weekend; longer windows (14d, 30d) noticeably delay legitimate patch adoption.

**Trade-off:** Security patches for genuine vulnerabilities also wait 3 days under this rule. If a CVE drops with a fix released minutes ago, the install will fail until the threshold elapses or the contributor bypasses the rule deliberately (documented escape hatch: `pnpm install --no-minimum-release-age` or pin a specific older version). Three days is short enough that this is rarely painful for patch waves and long enough to catch most malicious publishes.

### Decision 4: `lockfile-lint` runs as both a `preinstall` script AND an explicit CI step

**Rationale:** Two independent enforcement points. The `preinstall` script catches contributors who run `pnpm install` locally after a malicious PR has been merged but before they pull. The CI step catches the malicious PR before merge. Belt and suspenders; neither alone is sufficient.

**Open question** (task 1.6): pnpm's `ignore-scripts=true` behaviour against the ROOT package's `preinstall` script needs to be verified empirically. pnpm docs distinguish "scripts of the project being installed" from "scripts of dependencies", and `ignore-scripts` is documented to apply to dependencies. If empirical test shows pnpm 10 honours root-package lifecycle scripts regardless of `ignore-scripts`, the `preinstall` hook works as designed. If pnpm 10 blocks all scripts including root, the fallback is to drop the `preinstall` hook and rely on the CI step alone, plus document a manual `pnpm lockfile:lint` step in CONTRIBUTING.md. Both paths are acceptable; task 1.6 selects between them.

### Decision 5: Skill is general/portable, repo enforcement is local

**Rationale:** The user explicitly chose the general framing. Practical effect:

- The skill's `SKILL.md` documents all 17 practices with neutral language and per-package-manager command examples. It says "for pnpm 10.26+, set `blockExoticSubdeps: true`" — not "this repo has set blockExoticSubdeps".
- The repo-specific choices (the husky allowlist, the 3-day cooldown, the exact `.npmrc` contents) live in Rembric's own files (`pnpm-workspace.yaml`, `.npmrc`, `CONTRIBUTING.md`).
- The skill carries `references/source.md` with the upstream URL, the commit SHA we read against, and the date — so future readers know how to refresh the doc when upstream evolves.

**Trade-off:** Two places to update when a practice changes upstream — the skill (because it's the doc of record) and the repo config (if the change should affect Rembric specifically). The two updates are atomic and reviewable; the alternative (a single Rembric-coupled doc) would make the skill less reusable.

### Decision 6: Skill description threads the needle between over- and under-triggering

**Rationale:** The skill loader's match heuristic is keyword-driven against the `description` field. Two failure modes to avoid:

- **Over-trigger:** A description like "covers npm security" fires on every casual security question and every `pnpm install`. The agent then loads the skill into context constantly, eating tokens.
- **Under-trigger:** A description like "applies the lirantal best practices to this repo" only fires on a literal reference to the upstream and never gets activated organically.

The chosen approach (negotiated in task 6.2): describe **moments of action** — adding a dep, editing `.npmrc` / `pnpm-workspace.yaml`, reviewing a `package.json` diff, onboarding to the install posture — rather than the abstract topic. This pattern matches on the change-shape, not on the topic-shape.

**Acceptance check** for the description (task 6.2): mentally simulate three positive triggers ("I'm adding express to this project", "should I bump this lockfile?", "review my .npmrc") and three negative triggers ("is npm secure?", "how do I run pnpm install?", "what's a supply-chain attack?"). The description SHALL fire on the first three and SHALL NOT fire on the last three. Adjust until both criteria hold.

### Decision 7: Out of scope — `.env`, devcontainer, npq/sfw, npx hardening, publishing

**Rationale:** Each of these was deliberately deferred for a different reason (operator confirmed N/A, already covered by another file, optional operator-side tool, no runtime path uses it, package is private). Documenting them all in the skill is sufficient — they don't justify enforcement in this repo. Listed explicitly in proposal.md::Out of Scope so future readers don't try to "complete" the change by adding them.

## Risks

- **R1: pnpm 10 breaks an existing workflow.** Likely surface: peer-dep resolution against `vitest` or `drizzle-kit`, behavior change of `pnpm install --prod --ignore-scripts` in the Dockerfile, `corepack` not honoring the new pin in some CI runner. Mitigation: tasks 1.2-1.5 run the full CI matrix (build, test, typecheck, lint, docker:dev:up, docker-publish smoke) before any of the new policy flags are added. If pnpm 10 introduces an unfixable regression, fall back to Tension A2 (`@lavamoat/allow-scripts`) for #1 and document #2/#3 as "blocked on pnpm 10 upgrade" in the skill.
- **R2: `minimumReleaseAge: 4320` blocks a critical security patch.** Documented escape hatch: `pnpm install --no-minimum-release-age` (per-invocation) or temporarily lowering the value in `pnpm-workspace.yaml`. Re-tighten in a follow-up PR. Document the escape in `CONTRIBUTING.md`.
- **R3: `blockExoticSubdeps: true` rejects a legitimate transitive dep.** Likely if a popular package starts shipping a git-based sub-dep (rare but happens). Mitigation: pnpm error message identifies the offending package; we file an upstream issue and pin around it locally. The current dep graph passes (verified in task 1.5).
- **R4: Husky's `prepare` script gets compromised in a future release.** Targeted attack against a single named exception. Mitigation: the allowlist makes husky's privileged status visible in `git blame` of `pnpm-workspace.yaml`, so unexpected changes to its source surface during dep bumps. Higher-value follow-up (out of scope here): a separate change that replaces husky with a checked-in `.git/hooks/` script and removes the allowlist entirely.
- **R5: The skill drifts from upstream best practices.** Liran Tal's repo will evolve. Mitigation: `references/source.md` records the commit SHA and date we read against. A reminder in `CONTRIBUTING.md` (or a calendar tickler in the operator's process) prompts a re-read on a quarterly cadence.

## Rollback

- Revert this change's commit. pnpm 9.12.0 is restored via `packageManager`, `corepack` re-pins on next install, `.npmrc` + `pnpm-workspace.yaml` are deleted, `lockfile-lint` is removed from `package.json`, the skill is deleted, and `pnpm-lock.yaml` is regenerated against pnpm 9. No persistent state changes (no DB migrations, no operator-facing data); rollback is a pure revert + rebuild.
