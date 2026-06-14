## Context

`release-please-config.json` runs six components (`server`, `plugin-shared`@`apps/plugin`, and four `apps/plugin/.X-plugin` clients) plus a `linked-versions` plugin `plugin-suite` grouping `[plugin-shared, claude-code-plugin, codex-plugin, opencode-plugin]`. The `linked-versions` plugin hardcodes the grouped PR title to `chore${scope}: release plugin-suite libraries` (verified in release-please `src/plugins/linked-versions.ts`) — no `${version}`. release-please parses merged release PRs by title to create tags; a version-less title can't be parsed, so the merged group PR is never tagged, and the next run aborts ("untagged, merged release PRs outstanding"). No config option overrides this title. Already hit twice today; each needed manual `gh release create` + relabel.

Separately, the four capability specs describe an OLDER model than the live config (a `bridge-bundlers` group of `[claude-code-plugin, codex-plugin]` and "five components"). So spec, config, and `CLAUDE.md` have all drifted apart.

Version carriers (confirmed): `apps/plugin/package.json::version` (node root, 0.11.1), `.claude-plugin/plugin.json::version`, `.codex-plugin/plugin.json::version`, `.opencode-plugin/plugin.ts` (annotated `x-release-please-start-version` block), `.hermes-plugin/plugin.yaml::version`. The tag `plugin-shared-v0.11.1` already exists (created during today's manual unblock).

## Goals / Non-Goals

**Goals:**

- Eliminate the `linked-versions` plugin so every release PR has a version in its title and auto-tags on merge.
- Keep Claude Code + Codex in lock-step (they bundle the cached bridge) by making them one component, not a group.
- Preserve opencode and hermes as independent components (re-fetchers) — no config change to them.
- Realign spec + config + `CLAUDE.md` to one true model.
- Zero tag migration; installed-version detection unchanged.

**Non-Goals:**

- Renaming the merged component (kept `plugin-shared` to reuse its existing tag).
- Changing any plugin runtime behavior, bridge, hooks, or installer flow beyond `component_key()`.
- Touching opencode/hermes release config.
- Publishing `@rembric/plugin` to npm (stays `private`).

## Decisions

**1. Merge into `plugin-shared` (keep the name), not a new `plugin` component.** Keeping the component name means the existing `plugin-shared-v0.11.1` tag remains the anchor — release-please computes the next bump (→ 0.12.0 from the #132 feat) with no bootstrap tag. Renaming to `plugin` would need a one-time `plugin-v<cur>` anchor tag; not worth the risk. The name is now a mild misnomer (it owns claude+codex too, not just shared) — accepted; documented in `CLAUDE.md`.

**2. Path + extra-files shape.** `apps/plugin` with `exclude-paths: ["apps/plugin/.opencode-plugin", "apps/plugin/.hermes-plugin"]` makes the component fire on shared assets and on the claude/codex dirs. `extra-files` adds `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` — bare-string JSON entries; release-please's node strategy bumps the top-level `version` key (the same mechanism the standalone `.claude-plugin`/`.codex-plugin` components used, now relative to `apps/plugin`). `apps/plugin/package.json` + `apps/plugin/CHANGELOG.md` are handled by the node release-type itself.

**3. Remove `linked-versions` entirely; do not try to fix the title.** The title is hardcoded in the plugin, so no `group-pull-request-title-pattern` helps (confirmed against release-please docs + source). The only durable fix is no grouping.

**4. opencode/hermes untouched.** They are re-fetchers and already independent. This keeps the diff minimal and matches the documented rationale.

**5. Delete the two client CHANGELOG stubs.** `.claude-plugin/CHANGELOG.md` and `.codex-plugin/CHANGELOG.md` only ever held "Synchronize plugin-suite versions"; real history lives in `apps/plugin/CHANGELOG.md`. Leaving them orphaned (release-please no longer writes them) would rot.

**6. Live migration ordering.** Land the config change, then close group PR #133 + delete branch `release-please--branches--main--components`/`groups--plugin-suite`, then let release-please open the `plugin-shared` 0.12.0 PR (verified via dry-run that its title carries the version). #133 must be closed because its branch/grouping no longer exists in the new model.

## Risks / Trade-offs

- [release-please miscomputes the next plugin version after the component set changes] → The anchor tag `plugin-shared-v0.11.1` is unchanged and the manifest keeps `apps/plugin: 0.11.1`, so the diff base is stable; verify with `release-please --dry-run` (or a `workflow_dispatch` run inspected before merging the resulting PR) that the next PR is `plugin-shared 0.12.0` with the four expected file bumps.
- [bare-string `extra-files` doesn't bump nested client `plugin.json` under the new root] → Mitigate by confirming in the dry-run PR diff that both `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` versions changed; if the bare string mis-resolves, switch to explicit `{ "type": "json", "path": ".claude-plugin/plugin.json", "jsonpath": "$.version" }`.
- [Orphaned per-client tags confuse future runs] → They don't: release-please only consults tags for currently-configured component names. `claude-code-plugin-v*` / `codex-plugin-v*` become inert history.
- [Closing #133 loses the pending 0.12.0 bump] → It doesn't; the bump is recomputed from commits since `plugin-shared-v0.11.1` and re-emitted as the new `plugin-shared` PR.
- [Installer version table breaks] → `component_key()` for claude/codex now points at `apps/plugin`; `install.test.ts` `PLUGIN_VERSION` follows. Covered by the existing version-detection tests.

## Migration Plan

1. Edit `release-please-config.json` (+ manifest), delete the two CHANGELOG stubs, update `install.sh` + `install.test.ts`, rewrite the `CLAUDE.md` section + skill.
2. Run `pnpm run e2e:installer`, `lint`, `typecheck`.
3. Land via PR. After merge, **dry-run / inspect** the release-please run: confirm the new `plugin-shared` PR title carries `0.12.0` and bumps `apps/plugin/package.json`, both client `plugin.json`s, and `CHANGELOG.md`.
4. Close PR #133 and delete its group branch.
5. Merge the new `plugin-shared` PR → confirm `plugin-shared-v0.12.0` tag + GitHub release are created automatically (no manual step).

Rollback: revert the config/manifest commit; the prior six-component+linked-versions config is restored from git. No data is touched.

## Open Questions

None blocking. The bare-string-vs-explicit `extra-files` form is settled by inspecting the first dry-run diff (decision 2 / risk 2).
