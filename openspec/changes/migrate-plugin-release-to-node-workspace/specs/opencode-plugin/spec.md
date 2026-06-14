## MODIFIED Requirements

### Requirement: Plugin version managed by release-please as an independent component

The version recorded in `apps/plugin/.opencode-plugin/plugin.ts`'s `// @rembric-plugin-version` comment SHALL track the `opencode-plugin` release-please component's version. opencode is configured as an **independent component** with `release-type: simple` in `release-please-config.json` — `simple` (not `node`) because the `node-workspace` plugin reads a `package.json` for every `node` component and opencode has none; `simple` keeps it out of the dependency graph. There is no `linked-versions` group at all. The Claude Code and Codex surfaces are their own independent components (`claude-code-plugin`, `codex-plugin`) that declare `@rembric/plugin` as a dependency, so the `node-workspace` plugin (`merge: false`) cascades a patch bump to them when shared assets change. `opencode-plugin` declares NO dependency on `@rembric/plugin` and is therefore outside the cascade graph. The rationale: opencode's `install.sh` re-fetches shared assets (`apps/plugin/bin/`, `apps/plugin/scripts/`) from `main` at install time, so shared-asset changes reach opencode installs without requiring a coordinated version bump.

Likewise, `apps/plugin/.hermes-plugin/plugin.yaml::version` is its own independent release-please component outside the cascade graph for the same reason.

Operators do NOT hand-edit any of the version surfaces. Conventional Commits drive bumps via release-please.

#### Scenario: opencode-scoped change bumps only the opencode-plugin component

- **WHEN** a Conventional Commit scoped to `opencode` (e.g. `feat(opencode): ...`) lands on `main`
- **THEN** release-please opens (or updates) a release PR that bumps only the `// @rembric-plugin-version` comment in `apps/plugin/.opencode-plugin/plugin.ts` and the manifest entry for the `opencode-plugin` component — `plugin-shared`, `claude-code-plugin`, `codex-plugin`, and `hermes-plugin` are untouched

#### Scenario: Shared-asset change cascades to the client components but not opencode

- **WHEN** a Conventional Commit modifies a shared file under `apps/plugin/bin/` or `apps/plugin/scripts/`
- **THEN** release-please bumps `plugin-shared` and cascades a `+patch` to `claude-code-plugin` and `codex-plugin` via `node-workspace`
- **AND** `opencode-plugin` and `hermes-plugin` remain on their previous versions and pick up the shared change at next install (their installers re-fetch from `main`)
