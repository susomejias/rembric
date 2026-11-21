## 1. Contract

- [x] 1.1 Write the proposal, design and delta specifications for the plugin release ref.
- [x] 1.2 Validate with `openspec validate serve-plugins-from-release-ref --strict`, `pnpm run check:delta-freshness`, `pnpm run check:delta-sections` and `pnpm run check:spec-crossrefs`.

## 2. Release workflow

- [ ] 2.1 Add RED assertions to `scripts/release-workflow.test.ts` for `promote-plugin-release`: needs, gate, read-only `GITHUB_TOKEN`, SHA-pinned App token, queued concurrency, env-only inputs, the npm guard, the no-op path and force only on dispatch.
- [ ] 2.2 Add the job and the `plugin_release_tag` dispatch input; observe GREEN and check the YAML.

## 3. Installer and manifests

- [ ] 3.1 Add RED tests in `install.test.ts`: plugin artifacts and manifest by resolved SHA, server artifacts on `main` with no resolution, git-missing fallback, explicit `--ref` / `REMBRIC_REF` override, Hermes SHA pinning (install, update, no-op, unresolvable refusal, pinned metadata accepted).
- [ ] 3.2 Split the installer's ref by track, resolve the plugin commit once, and pin Hermes; update the Hermes adapter and the opencode script defaults; observe GREEN.
- [ ] 3.3 Point `.claude-plugin/marketplace.json` (`git-subdir`) and `.codex-plugin/marketplace.json` at `plugin-release`.

## 4. Documentation and verification

- [ ] 4.1 Update `CLAUDE.md`, `apps/plugin/README.md`, `docs/agents.md` and the `rembric-tui-installer` skill, including owner prerequisites.
- [ ] 4.2 Run the headless installer layer (vitest, `sh -n`, Hermes unittest) and the sandboxed local round-trips; record the layers that were skipped.
- [ ] 4.3 Owner (before merge): create `plugin-release` at the latest `plugin-v*` tag, the GitHub App with `PLUGIN_RELEASE_APP_CLIENT_ID` / `PLUGIN_RELEASE_APP_PRIVATE_KEY`, and the ruleset with the App as the bypass actor, including force pushes.
- [ ] 4.4 Operator: confirm the real-client layers (Claude keychain token after migration, Hermes `install --force --ref` keeping enabled state).
