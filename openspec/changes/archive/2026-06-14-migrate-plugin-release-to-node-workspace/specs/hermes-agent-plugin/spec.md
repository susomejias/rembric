## MODIFIED Requirements

### Requirement: Version coupling with other client manifests

The `version` field in `apps/plugin/.hermes-plugin/plugin.yaml` SHALL be managed by release-please's `hermes-plugin` component independently of the other plugin clients. There is NO `linked-versions` group. The Claude Code and Codex surfaces are their own independent components (`claude-code-plugin`, `codex-plugin`) that declare `@rembric/plugin` as a dependency, so the `node-workspace` plugin (`merge: false`) cascades a patch bump to them when shared assets under `apps/plugin/bin/`, `hooks/`, `commands/`, or `scripts/` change. `opencode-plugin` and `hermes-plugin` declare NO such dependency and are therefore outside the cascade graph — fully independent.

`hermes-plugin` is independent of `plugin-shared` because the Hermes installer re-fetches from `main` at install time; changes to shared code under `apps/plugin/` reach Hermes users on their next `curl … install.sh | sh` run without requiring a coordinated `hermes-plugin-vX.Y.Z` release.

The "Releasing a new plugin version" rule in `CLAUDE.md` SHALL describe this per-component model (server · plugin-shared · claude-code-plugin · codex-plugin · opencode-plugin · hermes-plugin, node-workspace cascade, no grouping).

#### Scenario: A Hermes-only fix produces only a Hermes release

- **WHEN** a contributor merges a `fix:` commit that modifies only files under `apps/plugin/.hermes-plugin/`
- **THEN** release-please SHALL open a release PR that bumps only `hermes-plugin`
- **AND** `plugin-shared`, `claude-code-plugin`, `codex-plugin`, `opencode-plugin`, and `server` versions SHALL remain unchanged
- **AND** the resulting git tag SHALL be of the form `hermes-plugin-vX.Y.Z`

#### Scenario: A shared-bin change does not produce a Hermes release

- **WHEN** a contributor merges a `feat:` commit that modifies `apps/plugin/bin/rembric-bridge.mjs`
- **THEN** release-please SHALL bump `plugin-shared` and cascade a `+patch` to `claude-code-plugin` and `codex-plugin` (the dependents) via `node-workspace`
- **AND** `hermes-plugin` SHALL NOT be bumped (it is outside the cascade graph)
- **AND** Hermes users SHALL receive the updated bridge on their next re-run of the install.sh from `main`
