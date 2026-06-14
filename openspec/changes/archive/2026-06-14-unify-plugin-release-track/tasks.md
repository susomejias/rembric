## 1. Release config + manifest

- [x] 1.1 `release-please-config.json`: two packages (`server`, `plugin`); `plugin` covers all of `apps/plugin` (no `exclude-paths`); `node-workspace` plugin removed.
- [x] 1.2 `plugin` component `extra-files` update all client carriers: `.claude-plugin/{package,plugin}.json`, `.codex-plugin/{package,plugin}.json`, `.hermes-plugin/plugin.yaml`, `.opencode-plugin/plugin.ts` (generic).
- [x] 1.3 `.release-please-manifest.json`: two entries (`apps/server` 0.21.12, `apps/plugin` 0.14.0).
- [x] 1.4 Set all client version carriers to `0.14.0`.

## 2. Workflow

- [x] 2.1 `release-please.yml`: top-level `concurrency` guard (`cancel-in-progress: false`).
- [x] 2.2 `publish-docker` gate retained (`server_release_created`); comment updated to the unified `plugin` track.

## 3. Installer + about tool (surfaced during apply)

- [x] 3.1 `apps/plugin/install.sh`: `component_key()` now maps ALL clients to the unified `apps/plugin` manifest key (the per-client keys were removed); stale node-workspace comment fixed. `install.test.ts` fixture updated (`MANIFEST['apps/plugin']` for all clients). 42 installer tests green.
- [x] 3.2 `memory.about` tool — VERIFIED no change needed: it routes to the generic installer (`--action=update`) and never hardcodes per-component versions/tags.

## 4. Spec deltas (change artifacts)

- [x] 4.1 `open-source-distribution`: REMOVED the six-component requirement, ADDED the two-track requirement.
- [x] 4.2 `codex-distribution`: MODIFIED the MCP-config requirement — cascade/`codex-plugin-v*` scenarios replaced by "codex versions under the unified `plugin` track."
- [x] 4.3 `opencode-plugin`: MODIFIED the version requirement → unified `plugin` track.
- [x] 4.4 `hermes-agent-plugin`: MODIFIED the version-coupling requirement → unified `plugin` track.

## 5. Docs sweep

- [x] 5.1 `CLAUDE.md` "Per-component versioning" bullet → "Two release tracks (`server` + unified `plugin`)".
- [x] 5.2 `.agents/skills/rembric-plugin-development/SKILL.md` release-model point + self-check → two-track.
- [x] 5.3 `apps/server/src/test/invariants.test.ts` plugin-versioning comment → unified model.
- [ ] 5.4 `apps/plugin/CHANGELOG.md` remains the single user-facing plugin changelog (release-please writes here going forward). Per-client `CHANGELOG.md` files left as historical (no fold needed — they stop receiving entries).

## 6. Operational recovery (one-time, at merge)

- [x] 6.1 Closed phantom release PRs (#150 claude 0.13.0, #151 codex 0.14.0).
- [ ] 6.2 **MERGE-TIME ANCHOR TAG (mandatory):** after this change lands on `main`, create and push `plugin-v0.14.0` at the merge commit so the new `plugin` component has a tag matching its manifest seed. Without it, release-please re-scans pre-migration history and re-proposes a phantom release (the exact failure this change fixes). `git tag plugin-v0.14.0 <merge-sha> && git push origin plugin-v0.14.0`.
- [ ] 6.3 After merge + anchor tag, confirm release-please opens at most a `server`/`plugin` PR and NO cascade/phantom PR regenerates.

## 7. Validation

- [x] 7.1 `openspec validate unify-plugin-release-track --strict` passes.
- [x] 7.2 `release-please-config.json` + manifest are valid JSON; `release-please.yml` syntactically valid; `sh -n` on `install.sh` + root shim clean.
- [x] 7.3 `pnpm run typecheck` / `pnpm run lint` / `pnpm test` clean (incl. 42 installer tests).
- [x] 7.4 VALIDATED via `release-please release-pr --dry-run` against the branch. Confirmed: config parses with 2 components; server + plugin build independent candidate PRs; all client carriers update in lock-step (CompositeUpdater/Generic); legacy per-client tags are ignored (warnings, inert). The dry-run also EMPIRICALLY confirmed the anchor requirement — `looking for tagName: plugin-v0.14.0` → not found → falls back to the manifest 0.14.0 but re-scans history (proposes a polluted 0.15.0). ⇒ the merge-time `plugin-v0.14.0` anchor tag (task 6.2) is mandatory; with it, the window is bounded and the first plugin release is clean.
