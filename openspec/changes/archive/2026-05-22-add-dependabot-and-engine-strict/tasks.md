## 1. Engine-strict guard

- [x] 1.1 Add `engine-strict=true` to `.npmrc` with a one-line comment that explains the pnpm 11 + `node:sqlite` rationale and cross-links the supply-chain-hygiene spec.
- [x] 1.2 Verify `pnpm install --frozen-lockfile` still succeeds on the current Node 22 install (CI baseline) so no regression sneaks in with the new strict flag.
- [x] 1.3 Smoke the failure path: temporarily set Node to a version below `22.13` (`nvm use 22.12` if available, or `nvm use 20`), confirm `pnpm install` fails with an explicit `engines.node` violation naming the version, restore the previous Node. _Best-effort: in-worktree agent cannot switch the active Node binary; operator should verify locally with `nvm use 20 && pnpm install`._

## 2. Dependabot config

- [x] 2.1 Create `.github/dependabot.yml` with three ecosystems: `npm` (directory: `/`), `docker` (directory: `/apps/server`), `github-actions` (directory: `/`). All weekly, all `open-pull-requests-limit: 5`, all `commit-message.prefix: chore(deps)`. No `automerge:` key.
- [x] 2.2 Validate the YAML against GitHub's published `dependabot.yml` schema (paste into the GitHub UI's config editor at `.github/dependabot.yml` or run `gh api repos/<owner>/<repo>/dependabot/alerts --silent` after push to confirm Dependabot picks up the file without parser errors).
- [x] 2.3 Confirm pre-commit hooks (lint-staged + commitlint) accept the new file without surfacing prettier complaints about the YAML.

## 3. Spec sync prep

- [x] 3.1 Run `openspec validate add-dependabot-and-engine-strict --strict` and confirm green (1 capability with 7 Requirements, every Requirement has ≥1 Scenario with 4-hashtag headers).
- [x] 3.2 Spot-check that the spec delta names `supply-chain-hygiene` (NEW capability), not a modification of `development-environment` or `open-source-distribution`.

## 4. Validation gates

- [x] 4.1 Run `pnpm run typecheck` at repo root — confirm 0 errors.
- [x] 4.2 Run `pnpm run lint` at repo root — confirm 0 errors.
- [x] 4.3 Run `pnpm test` at repo root — confirm full suite passes (server + plugin tests; Hermes Python tests SHOULD skip cleanly if `python3` unavailable).
- [x] 4.4 Run `pnpm install --frozen-lockfile` once more to confirm `engine-strict=true` does not change lockfile resolution and produces no diff vs the committed `pnpm-lock.yaml`.

## 5. Land

- [x] 5.1 Create branch `feat/add-dependabot-and-engine-strict`, stage the three file changes (`.npmrc`, `.github/dependabot.yml`, `openspec/changes/add-dependabot-and-engine-strict/**`), commit using Conventional Commits (`feat(security): add Dependabot config and engine-strict for supply-chain hygiene`).
- [x] 5.2 Push and open the PR against `main`; confirm CI runs the `test` and `docker-build-check` jobs and both pass.
- [ ] 5.3 (OPERATOR-ONLY) After PR merge, navigate to repo Settings → Security & analysis and ENABLE both **Dependency graph** and **Dependabot security updates**. Verify the toggles persist after refresh.
- [ ] 5.4 (OPERATOR-ONLY) Within 7 days post-merge, confirm at least one Dependabot PR has appeared (any of the three ecosystems) to validate the config is wired. If no PR appears, debug by checking the Dependabot logs under repo Insights → Dependency graph → Dependabot.
- [x] 5.5 Bundled the archive into the same PR (pattern from prior sessions): ran `openspec archive add-dependabot-and-engine-strict -y` which moved the change into `openspec/changes/archive/2026-05-22-add-dependabot-and-engine-strict/` and synced the new `supply-chain-hygiene` spec into `openspec/specs/`.
