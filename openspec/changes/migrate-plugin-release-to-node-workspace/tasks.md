## 1. Client package.json + manifests

- [x] 1.1 Add `apps/plugin/.claude-plugin/package.json` (`private: true`, `name: "@rembric/plugin-claude-code"`, `version` = current `apps/plugin` version, `dependencies: { "@rembric/plugin": <range> }`)
- [x] 1.2 Add `apps/plugin/.codex-plugin/package.json` (same shape, `name: "@rembric/plugin-codex"`)
- [x] 1.3 Run `pnpm install` and assert `pnpm-lock.yaml` is byte-identical (the client dirs are NOT workspace members — `git diff --exit-code pnpm-lock.yaml`)

## 2. release-please config

- [x] 2.1 Re-add `apps/plugin/.claude-plugin` and `apps/plugin/.codex-plugin` packages to `release-please-config.json` (`release-type: node`, `component: claude-code-plugin` / `codex-plugin`, `include-component-in-tag`, `include-v-in-tag`, `changelog-path`, `bump-minor-pre-major: true`, `bump-patch-for-minor-pre-major: false`, `extra-files: ["plugin.json"]`)
- [x] 2.2 Narrow `apps/plugin` (`plugin-shared`) `exclude-paths` back to all four client dirs; remove its `extra-files`
- [x] 2.3 Add `"plugins": [{ "type": "node-workspace", "merge": false }]` to `release-please-config.json`
- [x] 2.4 Switch `apps/plugin/.opencode-plugin` from `release-type: node` to `release-type: simple` (node-workspace requires a `package.json` for every `node` component; opencode has none — `simple` keeps it out of the graph)
- [x] 2.5 Re-add `apps/plugin/.claude-plugin` and `apps/plugin/.codex-plugin` entries to `.release-please-manifest.json`, seeded at the live client `plugin.json` version

## 3. Installer + tests

- [x] 3.1 Revert `component_key()` in `apps/plugin/install.sh` so claude/codex map back to their per-client dirs
- [x] 3.2 Update `install.test.ts` `PLUGIN_VERSION` map so claude/codex read their per-client manifest entries
- [x] 3.3 Run `pnpm run e2e:installer`, `pnpm run lint`, `pnpm run typecheck`, `pnpm test` — all green

## 4. Docs + spec sync

- [x] 4.1 Rewrite the per-component versioning section in `CLAUDE.md` to the six-component + node-workspace model; record that client `package.json`s are release-graph-only (not pnpm members)
- [x] 4.2 Update `.agents/skills/rembric-plugin-development/` everywhere it describes the four-component/collapse model
- [x] 4.3 Update the descriptive plugin-component comment in `.github/workflows/release-please.yml` (no functional change)

## 5. Cutover (BEFORE merging any release PR)

- [x] 5.1 Dry-run PASSED (2026-06-14, throwaway branch): node-workspace resolved `@rembric/plugin`→client edges despite clients not being pnpm members (`@rembric/plugin bumped to 0.12.1` in both client PRs); lockfile untouched
- [x] 5.2 Dry-run PASSED: three separate version-titled PRs (`plugin-shared 0.12.1`, `claude-code-plugin`, `codex-plugin`), no combined PR
- [ ] 5.3 Create anchor tags `claude-code-plugin-v<seed>` and `codex-plugin-v<seed>` at the migration HEAD (seed = current client `plugin.json` version) so the first cascade is a clean `+patch`, not a pre-migration history re-scan (dry-run showed an inflated `0.13.0` minor without anchors)
- [ ] 5.4 After landing config + anchor tags, re-run the dry-run and confirm the next shared change cascades a `+patch` (not minor) to both clients, and a Claude-only change produces ONLY a `claude-code-plugin` PR
- [ ] 5.5 Merge a real release PR and confirm it auto-tags (`<component>-vX.Y.Z`) with no "untagged, merged release PRs outstanding" abort

## 6. Archive

- [x] 6.1 Run `openspec validate migrate-plugin-release-to-node-workspace --strict` — green
- [ ] 6.2 After land + verified release, `/opsx:archive` this change (it supersedes `2026-06-14-collapse-plugin-release-components`)
