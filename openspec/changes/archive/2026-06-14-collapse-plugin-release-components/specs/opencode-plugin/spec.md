## MODIFIED Requirements

### Requirement: Plugin version managed by release-please as an independent component

The version recorded in `apps/plugin/.opencode-plugin/plugin.ts`'s `// @rembric-plugin-version` comment SHALL track the `opencode-plugin` release-please component's version. opencode is configured as an **independent component** in `release-please-config.json`. There is no `linked-versions` group at all: the Claude Code and Codex surfaces are owned by the single `plugin-shared` component (which bumps them together when shared assets or either client directory change); `opencode-plugin` is separate from it. The rationale: opencode's `install.sh` re-fetches shared assets (`apps/plugin/bin/`, `apps/plugin/scripts/`) from `main` at install time, so shared-asset changes reach opencode installs without requiring a coordinated version bump.

Likewise, `apps/plugin/.hermes-plugin/plugin.yaml::version` is its own independent release-please component for the same reason.

Operators do NOT hand-edit any of the four version surfaces. Conventional Commits drive bumps via release-please.

#### Scenario: opencode-scoped change bumps only the opencode-plugin component

- **WHEN** a Conventional Commit scoped to `opencode` (e.g. `feat(opencode): ...`) lands on `main`
- **THEN** release-please opens (or updates) a release PR that bumps only the `// @rembric-plugin-version` comment in `apps/plugin/.opencode-plugin/plugin.ts` and the manifest entry for the `opencode-plugin` component — `plugin-shared` and `hermes-plugin` are untouched

#### Scenario: Shared-asset change bumps only plugin-shared

- **WHEN** a Conventional Commit modifies a shared file under `apps/plugin/bin/` or `apps/plugin/scripts/`
- **THEN** release-please bumps the single `plugin-shared` component (Claude Code + Codex surfaces) — `hermes-plugin` and `opencode-plugin` remain on their previous versions and pick up the shared change at next install (their installers re-fetch from `main`)

