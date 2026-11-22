## 1. Released-bridge contract guard (lands first, before any behaviour change)

- [x] 1.1 Commit the six `.mjs` files of `@rembric/mcp-bridge@0.45.1` under `apps/web/src/test/fixtures/mcp-bridge-0.45.1/` with a `checksums.json` taken from the npm tarball (tarball sha512 verified against the registry `integrity`); exclude the directory from ESLint and Prettier. The invariant suites pass with the fixture present (126/126), so no confinement-scan exclusion is needed
- [x] 1.2 Add `apps/web/src/test/released-bridge-contract.test.ts`: spawn the fixture's `cli.mjs` against a server started from the current tree and assert `initialize`, `tools/list`, a `tools/call` landing in the slug's project, a fingerprint-resolved connection whose header reaches the server, and a host-declared session that a `memory.save` attaches to; assert the fixture files match `checksums.json`
- [x] 1.3 Prove the guard with `scripts/mutate.mjs`: renaming the fingerprint header, renaming the session header, reshaping the `repositories/resolve` response and moving the slug path segment each turn the test red (4/4 caught). Protocol negotiation lives in the MCP SDK, not repository code; the test pins it by asserting `initialize` returns `2025-06-18`

## 2. Claude Code and Codex manifests

- [x] 2.1 RED first: update the manifest assertions in `apps/web/src/test/invariants.test.ts` and `apps/plugin/test/` to expect `command: "node"` with `${CLAUDE_PLUGIN_ROOT}/mcp-bridge/cli.mjs` (Claude) and `./mcp-bridge/cli.mjs` with `cwd: "."` (Codex), and to refuse `npx` or a package specifier
- [x] 2.2 Change `apps/plugin/.claude-plugin/mcp.json` and `apps/plugin/.codex-plugin/mcp.json`; the tests from 2.1 pass. In the same commit, drop the two `mcp.json` JSONPath entries from `release-please-config.json` `extra-files` (their `args[1]` target no longer exists) and delete `scripts/release-please-jsonpath.test.ts`
- [x] 2.3 Add a test that every module `cli.mjs` reaches by relative import exists under `apps/plugin/mcp-bridge/` and imports only siblings and `node:` builtins

## 3. opencode

- [x] 3.1 RED first, in `apps/plugin/.opencode-plugin/plugin.test.ts`: with `~/.config/rembric/bin/cli.mjs` present the hook sets `['node', '<abs>/cli.mjs']`; with it absent an existing `npx` or legacy command is left untouched, no entry is created, and one hint is logged
- [x] 3.2 Implement the hook in `apps/plugin/.opencode-plugin/plugin.ts`; delete `MCP_BRIDGE_VERSION`
- [x] 3.3 `apps/plugin/.opencode-plugin/install.sh`: fetch `cli.mjs`, `bridge.mjs`, `slug.mjs` and `rembric-host-binding.mjs` to `~/.config/rembric/bin/` with write-then-rename, write `rembric.ts` last, and print the `node` snippet; `install.test.ts` covers a full install (modules byte-identical to the repository), a source that stops mid-list (previous `cli.mjs` kept, no plugin file), a network failure that leaves partial curl output (previously installed modules intact, no `.tmp` left), and `opencode.json` staying untouched
- [x] 3.4 `apps/plugin/.opencode-plugin/uninstall.sh`: keep all six bridge modules (including `rembric-project.mjs` and `rembric-dotenv.mjs`, which the bridge imports and which this script used to remove unconditionally) while the Hermes `config.yaml` references `~/.config/rembric/bin/cli.mjs` (both the expanded and the `~/` spelling) and name them as kept; test both branches

## 4. Hermes and the TUI installer

- [x] 4.1 RED first, in `apps/plugin/.hermes-plugin/tests/test_migrate.py`: the `mcp-remote` block, the incomplete pinned block and the complete installer-written `npx` block each migrate to `command: node` with the downloaded `cli.mjs`, keeping `env` and `enabled` and taking one backup; a block with any extra key stays byte-identical and prints a hint; no migration runs when `cli.mjs` is missing. The bridge check covers all six modules, as the delta spec requires (a missing `rembric-dotenv.mjs` blocks migration too); the complete block's backup suffix is `rembric-mcp-npx`
- [x] 4.2 Implement in `apps/plugin/.hermes-plugin/install.sh` (`migrate_legacy_mcp_config` and the printed block); the printed block lives in `apps/plugin/install.sh::hermes_bridge_config` and now shows the `node` form
- [x] 4.3 `apps/plugin/install.sh`: place the bridge files for opencode and Hermes install and update, from the same ref as the client's other files, before any hook switch or migration; `--ref` / `REMBRIC_REF` still apply; `install.test.ts` covers install, update, a failed download (old config left working) and the control case that server artifacts are unaffected. opencode's own installer places them (3.3). For Hermes the TUI stages all six to `<name>.tmp.$$` and renames them only after every fetch succeeded, `cli.mjs` last; a failed fetch or rename aborts the Hermes action before the native command and the migration. Hermes's existing guard still refuses `REMBRIC_SRC`, `PLUGIN_SRC`, `REMBRIC_REF` and `--ref`, so its bridge always comes from the run's default ref; also covered: a rename failing mid-commit and a headless run without `--yes` placing nothing
- [x] 4.4 `apps/plugin/install.sh` uninstall: remove the bridge files only when opencode's plugin file is absent and the Hermes `config.yaml` does not reference `cli.mjs`; test opencode-only, Hermes-only, both, and a preserved Hermes MCP block keeping its bridge (both spellings), plus a failed native removal leaving the bridge untouched and a directory holding other files surviving
- [x] 4.5 Run `scripts/mutate.mjs` over each new guard in 3.x and 4.x (file-exists check, recognised-shape check, last-client check) and confirm the test naming it turns red. 4.x done by backup/edit/run/restore (`scripts/mutate.mjs` cannot run `install.test.ts`): bridge-exists check removed or narrowed to `cli.mjs`, complete-shape check widened, opencode and Hermes last-client checks removed, tilde spelling dropped, `cli.mjs` committed first, staging removed, per-file commit, placement skipped and prune ungated each turned the named test red, and every filter passes unmutated. 3.x: `scripts/mutate.mjs` caught the opencode hook's file-exists check (`plugin.test.ts`, 2 tests red); by backup/edit/run/restore, opencode uninstall's Hermes check and tilde spelling, `cli.mjs` fetched first and `install_file` staging removed each turned their `install.test.ts` case red

## 5. Keep publishing the bridge

- [x] 5.1 Owner decision 2026-11-22: the plugins run their shipped bridge and `@rembric/mcp-bridge` stays published for hand-written configs, with no `npm deprecate`. Commit `3c21375d` reverts `df9f1dc8`: `publish-npm` again asserts both tarballs (`scripts/pi-package.mjs assert-pack`, then `scripts/mcp-bridge-package.mjs assert-pack`) before publishing `@rembric/pi` and `@rembric/mcp-bridge`; `apps/plugin/mcp-bridge/package.json` is not private and keeps its `files` allowlist; `.github/workflows/release-please.yml`, the bridge `package.json`, `scripts/mcp-bridge-package.mjs`, `scripts/npm-publish.test.ts` and `scripts/release-workflow.test.ts` are identical to `main`
- [x] 5.2 `release-please-config.json` `extra-files` keeps `mcp-bridge/package.json` as a carrier; the two `mcp.json` JSONPath entries stay removed (2.2), because no manifest names a bridge version
- [x] 5.3 `apps/web/src/test/invariants.test.ts` (published-estate enumeration over both packages, no numeric bridge pin in operational files), `scripts/npm-publish.test.ts` (both assertions precede either publish) and `scripts/release-workflow.test.ts` pass after the revert
- [x] 5.4 Lockfile, `pnpm-workspace.yaml`, `.npmrc` and `ALLOWED_BUILD_SCRIPTS` are unchanged against `main`, so no `npm-security-best-practices` review is triggered

## 6. Docs and specs

- [x] 6.1 Replace the `npx` bridge instructions in `CLAUDE.md`, `apps/plugin/README.md`, `apps/plugin/mcp-bridge/README.md`, `apps/plugin/.opencode-plugin/README.md`, `apps/plugin/.hermes-plugin/README.md` and `docs/agents.md` (Hermes block, opencode troubleshooting, Codex bridge paragraph); leave the no-plugin HTTP sections as they are
- [x] 6.2 Update `.agents/skills/rembric-plugin-development/` (SKILL.md, `references/e2e-walkthrough.md`, `references/per-client-gotchas.md`) and `.agents/skills/rembric-tui-installer/`
- [ ] 6.3 `openspec validate run-bridge-from-plugin-tree --strict`, `pnpm run check:delta-sections`, `pnpm run check:spec-crossrefs` and `pnpm run check:delta-freshness` pass
- [ ] 6.4 At archive time, hand-edit the non-requirement prose the deltas cannot reach: `openspec/specs/claude-code-plugin/spec.md` `## MCP server declaration` and `## Project slug selection` (stale `bin/rembric-bridge.mjs`), the scenario title the freshness gate forced the `open-source-distribution` delta to keep ("The bridge's pin names the version that release publishes", although no pin remains), and reconcile `opencode-plugin` `Install script auto-configures opencode.json` with `Install script contract`
- [x] 6.5 After the owner decision (5.1), restore the published-package wording: proposal, design D6 and the deltas keep the bridge published for hand-written configs (the `supply-chain-hygiene` and `development-environment` deltas are deleted, the deprecation requirement is dropped), and the docs and skills show `npx -y @rembric/mcp-bridge@<version>` for stdio-only clients and for Hermes configured without the TUI, while the plugins run their shipped copy

## 7. Verification before merge

- [ ] 7.1 `pnpm run typecheck`, `pnpm run lint`, `pnpm test` and the Hermes Python suites pass
- [ ] 7.2 Run the `rembric-tui-installer-e2e` playbook: headless, local round-trips in a throwaway HOME, and the pty smoke
- [ ] 7.3 Operator, real clients in isolated config dirs, upgrade path from 0.45.x: Claude Code and Codex connect after a plugin update with the bridge spawned by `node`, and a `memory.save` attaches to the host session (this measures the host-binding path without the `npx` layer)
- [ ] 7.4 Operator, real clients: opencode and Hermes connect after a TUI update; Hermes's migrated block has a backup and Hermes stays enabled
- [ ] 7.5 Operator, not-updated path: a client left on its `npx -y @rembric/mcp-bridge@0.45.1` entry still connects to a server built from this branch

## 8. Release (owner)

- [ ] 8.1 Owner: merge; after the plugin release that contains this change is tagged, confirm on a real install of each client that the MCP server connects at once, with no wait for an npm publish
- [ ] 8.2 Close PR #556 as superseded and delete its `serve-plugins-from-release-ref` change with the branch; close issue #513
