## Why

Rembric is a Node application that pulls 27 first-order dependencies (9 runtime + 18 dev) from the public npm registry through pnpm. The repo today has only **partial** supply-chain defenses: CI uses `pnpm install --frozen-lockfile` and the Dockerfile's `runtime` stage uses `--ignore-scripts`, but the developer-facing install (`pnpm install` from a fresh clone, `pnpm add <pkg>` during normal work) runs the full lifecycle script gauntlet against arbitrary registry tarballs with no cooldown, no exotic-source blocking, and no lockfile validation.

Liran Tal's [`npm-security-best-practices`](https://github.com/lirantal/npm-security-best-practices) catalogues 17 hardening practices for npm-based projects. Three of those (2FA, provenance, OIDC) do not apply to Rembric because `package.json` declares `private: true` and the repo is never published to npm. Of the remaining 14, the repo already implements practices #6 (`--frozen-lockfile`), #7 (controlled bumps via release-please), and #14 (lean dependency tree). This change adopts the rest as **enforced repo config** for the practices that have a mechanical pnpm/CI knob, and as **documented operator process** (via a new skill) for the practices that are inherently human (Snyk lookups, tarball inspection, `.env` discipline).

The skill that this change creates SHALL be a **general** reference to the 17 practices — reusable across any npm/pnpm project — not a Rembric-specific prescription. The skill lives at `.agents/skills/npm-security-best-practices/` with a symlink at `.claude/skills/npm-security-best-practices` so it is discoverable from both the agent harness and Claude Code's skill loader.

## What Changes

- **PACKAGE MANAGER UPGRADE** Bump `packageManager` in `package.json` from `pnpm@9.12.0` to the latest pnpm 10.x line (current head ≥ `10.26.0`). The upgrade is the prerequisite for practices #2 (`blockExoticSubdeps`) and #3 (`minimumReleaseAge`), neither of which exist in pnpm 9. CI workflows (`ci.yml`, `docker-publish.yml`, `release-please.yml`) and the Dockerfile SHALL be re-validated end-to-end on pnpm 10 before merge.
- **`.npmrc` (NEW)** Add `.npmrc` at repo root setting `ignore-scripts=true`. This blocks ALL lifecycle scripts (pre/post-install, prepare, etc.) for the entire dep tree by default. Husky's `prepare` script is handled via Decision A1 below — pnpm 10's `onlyBuiltDependencies` allowlist in `pnpm-workspace.yaml`.
- **`pnpm-workspace.yaml` (NEW)** Add a root `pnpm-workspace.yaml` containing:
  - `allowBuilds:` per-package boolean map (pnpm 11 syntax; replaces the pnpm 10 `onlyBuiltDependencies` list) — narrow allowlist of packages permitted to run install scripts. The map permits `husky: true`, `better-sqlite3: true`, `sqlite-vec: true` (the three packages whose lifecycle scripts the repo genuinely needs) and explicitly denies `esbuild: false` (a transitive of vitest that pnpm flags during install). Any future dep that needs a postinstall (e.g., new native bindings) SHALL be added with `<pkg>: true` explicitly, surfaced in code review.
  - `blockExoticSubdeps: true` — pnpm 10.26+ flag that refuses transitive deps fetched from git URLs, tarball URLs, or any non-registry source.
  - `minimumReleaseAge: 4320` (= 3 days, in minutes) — pnpm 10.26+ install cooldown; refuses to install package versions newer than the threshold. Three days is the default suggested by upstream and aligns with the typical detection-to-takedown window for compromised npm releases.
- **`lockfile-lint` (NEW)** Add `lockfile-lint` as a devDependency. Add a `lockfile:lint` script to `package.json`:
  ```
  pnpm-lock.yaml validation: allowed-hosts (registry.npmjs.org), validate-https, validate-package-names, validate-checksum
  ```
  Wire `lockfile:lint` as a `preinstall` script AND as a dedicated step in `.github/workflows/ci.yml` (runs before `pnpm install --frozen-lockfile`). The preinstall hook itself is covered by the husky allowlist; the `preinstall` script on the root package runs even when `ignore-scripts=true` is set for **transitive** deps because pnpm distinguishes root-package lifecycle scripts from dep lifecycle scripts. _(Confirm this in task 1.6 before relying on it; alternative fallback documented in design.md.)_
- **CI VALIDATION** In `.github/workflows/ci.yml`, add a `Validate lockfile` job step that runs `pnpm lockfile:lint` BEFORE the `pnpm install --frozen-lockfile` step. The job SHALL fail the workflow if the lockfile contains exotic sources, non-HTTPS URLs, or missing checksums. Also confirm that all `pnpm install` invocations across the three workflow files use `--frozen-lockfile` (already true today) and document the contract in the spec.
- **DOCKERFILE** No functional change required in `Dockerfile`; the `runtime` stage already uses `pnpm install --frozen-lockfile --prod --ignore-scripts`. A comment SHALL be added to the runtime stage's install line referencing the `.npmrc` policy so future readers understand why both layers carry the flag.
- **SKILL (NEW, GENERAL)** Create `.agents/skills/npm-security-best-practices/` with:
  - `SKILL.md` — frontmatter (`name`, `description`) + body covering all 17 practices with concrete commands for npm, pnpm, yarn, and bun. Body is reusable across any npm-ecosystem project, not specialised to Rembric.
  - `references/checklist.md` — one-page summary of the 17 practices, suitable for quick scan during a dep-addition code review.
  - `references/pnpm-config.md` — annotated `.npmrc` and `pnpm-workspace.yaml` snippets.
  - `references/ci-snippets.md` — GitHub Actions step examples for `lockfile-lint` and frozen-install patterns.
  - `references/source.md` — upstream attribution (Liran Tal, repo URL, commit SHA snapshot date).
  - **No `scripts/`** in this iteration; the skill is documentation-first.
  - Symlink `.claude/skills/npm-security-best-practices` → `../../.agents/skills/npm-security-best-practices`, matching the pattern already used for `bun`, `mcp-builder`, `skill-creator`, `plugin-creator`, etc.
- **SKILL DESCRIPTION TRIGGERING** The `description` field in the skill's frontmatter SHALL fire on dep-addition / install-config / supply-chain review contexts and SHALL NOT fire on every casual `pnpm install` or generic security question. Target keywords: `package.json`, `.npmrc`, `pnpm-workspace.yaml`, `lockfile`, `dependency`, `supply chain`, `npm security`. Verbatim text negotiated in task 6.2.
- **DOCUMENTATION** Add a short section to `CONTRIBUTING.md` (or `docs/` if there's a more appropriate home) titled "Adding a dependency": link to the new skill, and call out the husky allowlist (any new dep that wants a postinstall must be added to `pnpm-workspace.yaml::onlyBuiltDependencies` and reviewed). `CLAUDE.md` SHALL get a one-line pointer to the skill under a new "Supply-chain hygiene" subsection so the agent uses it during dep work.

## Out of Scope

- **`.env` migration** to a secret manager (practice #9): the operator confirmed the local `.env` contains only dev-only tokens, not production secrets. The skill SHALL document the practice for general readers but no in-repo migration is performed.
- **`.devcontainer/devcontainer.json`** (practice #10): the repo already ships the Docker dev stack at `docker-compose.dev.yml`. A devcontainer config is additive and out of scope here.
- **`npq` / Socket Firewall** as required tooling (practices #4.1, #4.2): documented in the skill, not enforced by the repo.
- **Hardened `npx`** (practice #8): the repo's build does not invoke `npx` in any runtime path; documented in the skill only.
- **Publishing-related practices** (#11 2FA, #12 provenance, #13 OIDC): N/A — `private: true`. Documented in the skill for general use.
- **Dependency confusion** (#17): the package name is already scoped (`@susomejias/rembric`) and is `private: true` so cannot be confused. Documented in the skill in case the repo's publishing posture changes in the future.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `development-environment`: extend with **supply-chain hygiene** requirements covering the install-lifecycle posture of the repo. Specifically, requirements that `.npmrc` enforces `ignore-scripts=true`, that `pnpm-workspace.yaml` enforces `blockExoticSubdeps: true` + `minimumReleaseAge` + an `onlyBuiltDependencies` allowlist, that `lockfile-lint` runs in CI before any `pnpm install`, that `packageManager` pins a pnpm ≥10.26 line, and that the runtime Dockerfile stage continues to use `--ignore-scripts` even though the policy is now redundant via `.npmrc` (defense in depth).

## Impact

- **New files**:
  - `.npmrc`
  - `pnpm-workspace.yaml`
  - `.agents/skills/npm-security-best-practices/SKILL.md`
  - `.agents/skills/npm-security-best-practices/references/checklist.md`
  - `.agents/skills/npm-security-best-practices/references/pnpm-config.md`
  - `.agents/skills/npm-security-best-practices/references/ci-snippets.md`
  - `.agents/skills/npm-security-best-practices/references/source.md`
  - `.claude/skills/npm-security-best-practices` (symlink → `../../.agents/skills/npm-security-best-practices`)
- **Modified files**:
  - `package.json` — bump `packageManager`, add `lockfile-lint` devDep, add `lockfile:lint` script, add `preinstall: pnpm lockfile:lint`
  - `pnpm-lock.yaml` — regenerated under pnpm 10.x with the new `lockfile-lint` dep
  - `.github/workflows/ci.yml` — add `Validate lockfile` step; verify pnpm 10 compatibility
  - `.github/workflows/docker-publish.yml` — verify pnpm 10 compatibility (no change expected; build runs inside container with corepack)
  - `.github/workflows/release-please.yml` — verify pnpm 10 compatibility
  - `Dockerfile` — add an inline comment on the runtime stage's install line referencing `.npmrc`
  - `CONTRIBUTING.md` — new "Adding a dependency" section
  - `CLAUDE.md` — one-line "Supply-chain hygiene" pointer to the skill
- **Validation surface**:
  - `pnpm install` (clean clone, pnpm 10.x) — succeeds; husky hooks install (via the allowlist); no third-party scripts run.
  - `pnpm install --frozen-lockfile` (CI path) — succeeds; lockfile-lint passes before install.
  - `pnpm test`, `pnpm run typecheck`, `pnpm run lint` — pass.
  - `pnpm run dev:docker:up` — boots cleanly; the dev stage's `pnpm install --frozen-lockfile` does NOT regress (verify `--ignore-scripts` interaction with husky inside the container; husky isn't needed inside the container because there's no git checkout, so we expect a quiet skip).
  - `docker compose up` against the canonical compose — runtime stage starts with no behavioral change.
  - `lockfile-lint` against a hand-crafted bad lockfile (added as a fixture in a test) — fails as expected.
