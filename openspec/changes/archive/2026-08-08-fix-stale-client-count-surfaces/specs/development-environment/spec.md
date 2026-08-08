## MODIFIED Requirements

### Requirement: The repo MUST declare a pnpm workspaces layout under `apps/` and `packages/`

The repository root SHALL contain a `pnpm-workspace.yaml` that declares a `packages:` block listing exactly two glob entries: `apps/*` and `packages/*`. The existing supply-chain policy entries (`allowBuilds`, `blockExoticSubdeps`, `minimumReleaseAge`, `minimumReleaseAgeExclude` where present) SHALL remain in place verbatim — adding the `packages:` block SHALL NOT remove or alter the policy.

The `apps/` directory SHALL contain two workspace members on day one:

- `apps/server/` — the Node MCP+dashboard server (the Docker image target).
- `apps/plugin/` — the multi-client plugin tree (Claude Code, Codex CLI, Hermes Agent, opencode, Pi all under one directory).

The `packages/` directory SHALL exist (even if initially empty) so the layout convention is in place for future library extractions (e.g., a future `packages/bridge/` npm-published bridge) without requiring a follow-up restructure.

Each workspace member SHALL contain a `package.json` declaring `"name": "@rembric/<member>"` and `"private": true`. `apps/plugin/package.json` MAY be a minimal stub (name + version + private) because the directory contains assets that are not strictly importable npm modules; the stub exists so `pnpm` recognises the directory as a workspace member and `release-please` can track it.

#### Scenario: pnpm install resolves both workspace members

- **GIVEN** a fresh clone of the repo
- **WHEN** the contributor runs `pnpm install --frozen-lockfile`
- **THEN** pnpm SHALL recognize both `apps/server` and `apps/plugin` as workspace members
- **AND** `pnpm -r ls` SHALL list at minimum `@rembric/server` and `@rembric/plugin`
- **AND** the existing supply-chain policy (allowBuilds, blockExoticSubdeps, minimumReleaseAge) SHALL still apply

#### Scenario: `packages/` is empty but tracked

- **WHEN** a contributor inspects the repo
- **THEN** `packages/` SHALL exist as a directory (with at minimum a `.gitkeep` if no real packages live there yet)
- **AND** `pnpm-workspace.yaml` SHALL declare `packages/*` as a glob even though it currently matches no members
