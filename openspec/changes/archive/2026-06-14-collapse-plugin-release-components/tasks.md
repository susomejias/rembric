## 1. release-please config + manifest

- [x] 1.1 In `release-please-config.json`, broaden the `apps/plugin` package: set `exclude-paths` to ONLY `["apps/plugin/.opencode-plugin", "apps/plugin/.hermes-plugin"]`, and add `"extra-files": [".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]`. Keep component name `plugin-shared`, `release-type: node`, `package-name: @rembric/plugin`.
- [x] 1.2 In `release-please-config.json`, delete the `apps/plugin/.claude-plugin` and `apps/plugin/.codex-plugin` package entries. Leave `apps/plugin/.opencode-plugin`, `apps/plugin/.hermes-plugin`, and `apps/server` untouched.
- [x] 1.3 In `release-please-config.json`, delete the entire `"plugins": [ { "type": "linked-versions", ... } ]` block.
- [x] 1.4 In `.release-please-manifest.json`, delete the `apps/plugin/.claude-plugin` and `apps/plugin/.codex-plugin` keys. The remaining keys are `apps/server`, `apps/plugin`, `apps/plugin/.opencode-plugin`, `apps/plugin/.hermes-plugin`.
- [x] 1.5 `node -e "JSON.parse(require('fs').readFileSync('release-please-config.json'))"` and same for the manifest — both parse clean.

## 2. Delete orphaned CHANGELOG stubs

- [x] 2.1 `git rm apps/plugin/.claude-plugin/CHANGELOG.md apps/plugin/.codex-plugin/CHANGELOG.md` (they only held "Synchronize plugin-suite versions"; real history is in `apps/plugin/CHANGELOG.md`).

## 3. Installer + test wiring

- [x] 3.1 In `apps/plugin/install.sh` `component_key()`, map `claude)` and `codex)` to `apps/plugin` (was `.claude-plugin` / `.codex-plugin`). Leave `hermes)` → `apps/plugin/.hermes-plugin` and `opencode)` → `apps/plugin/.opencode-plugin` unchanged.
- [x] 3.2 In `install.test.ts`, update the `PLUGIN_VERSION` map: `claude` and `codex` → `MANIFEST['apps/plugin']`; `hermes`/`opencode` unchanged.
- [x] 3.3 `pnpm run e2e:installer` passes (includes `sh -n` + the version-detection and `--yes` cases against the new manifest keys).

## 4. Docs

- [x] 4.1 Rewrite the `CLAUDE.md` "Plugin development discipline" / per-component versioning bullet to the four-component model: `server` · `plugin-shared` (shared + Claude + Codex, tag `plugin-shared-v*`) · `opencode-plugin` · `hermes-plugin`; NO linked-versions group. Remove the `plugin-suite` / `bridge-bundlers` wording.
- [x] 4.2 Grep the `.agents/skills/rembric-plugin-development/` skill (SKILL.md + references) for `linked-versions`, `plugin-suite`, `bridge-bundlers`, `claude-code-plugin`, `codex-plugin` and update any spot that repeats the old per-component/grouped model.
- [x] 4.3 Update the descriptive comment in `.github/workflows/release-please.yml` that lists plugin component names (no functional change — the server-gating logic stays).

## 5. Validation (pre-merge)

- [x] 5.1 `pnpm run lint` and `pnpm run typecheck` pass.
- [x] 5.2 `openspec validate collapse-plugin-release-components --strict` passes.
- [x] 5.3 `git ls-files apps/plugin/` still shows one copy of each shared resource (no accidental duplication) — plugin invariant intact.

## 6. Live release-state migration (operator-confirmed; after the PR merges to main)

- [ ] 6.1 OPERATOR: after merge, inspect the release-please run (or a `workflow_dispatch` dry-run) — confirm the new `plugin-shared` release PR title carries the version (e.g. `chore(main): release plugin-shared 0.12.0`) and its diff bumps `apps/plugin/package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, and `apps/plugin/CHANGELOG.md`. If a client `plugin.json` did NOT bump, switch its `extra-files` entry to the explicit `{ "type": "json", "path": ".../plugin.json", "jsonpath": "$.version" }` form and re-run.
- [ ] 6.2 OPERATOR: close group PR #133 and delete its branch `release-please--branches--main--groups--plugin-suite` (now obsolete — no grouping in the new model).
- [ ] 6.3 OPERATOR: merge the new `plugin-shared` release PR and confirm `plugin-shared-v0.12.0` tag + GitHub release are created automatically and the PR is relabelled `autorelease: tagged` — with NO manual `gh release create`.
