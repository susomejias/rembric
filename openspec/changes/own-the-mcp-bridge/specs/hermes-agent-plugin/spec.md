## MODIFIED Requirements

### Requirement: User documentation

The plugin's `README.md` (at `apps/plugin/.hermes-plugin/README.md`) SHALL include, in this order:

1. The **TUI installer** as the primary install/upgrade instruction (the root `install.sh` shim, canonical URL `.../main/install.sh`, or `--agent=hermes`). The per-client manual install — `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh` followed by `hermes plugins install rembric` to trigger the `requires_env` prompts — SHALL be retained below under an explicitly-labelled "Manual install" heading, not as the lead instruction.
2. A description of what Hermes prompts for during install (the three `requires_env` vars) and where the answers are persisted (`${HERMES_HOME:-~/.hermes}/.env`).
3. A two-block `~/.hermes/config.yaml` example showing **both** the `mcp_servers.rembric` block (registering the bundled bridge via `node` or `npx`) AND the `memory: provider: rembric` block, so users wire both the tool surface and the lifecycle in one go.
4. A short "Project slug resolution" section explaining the four-step cascade in plain prose.
5. A "Troubleshooting" section that covers: provider visible in `hermes memory status` but server unhealthy, missing slug diagnostic, mismatched provider-vs-bridge slug, `~/.hermes/.env` edited manually after install.

Hermes is the one client whose MCP entry is **documented** rather than shipped as a manifest, so the transport contract other clients get from a tracked file has to be carried by this README instead — and a documented block that violates the contract teaches users to opt out of it. The `mcp_servers.rembric` block SHALL therefore satisfy four properties, each of which the block violated before this requirement:

- It SHALL name `@rembric/mcp-bridge` at an **exact pinned version**, never `mcp-remote` and never a floating tag such as `@latest`. `npx` re-resolves a floating tag on every session start, so a compromised or broken publish reaches the user immediately.
- Its `args` SHALL be exactly the `-y` flag and the pinned package specifier. There SHALL be **no** URL argument, **no** `--header` argument and **no** `--allow-http` argument: the bridge takes no arguments and reads its whole configuration from the environment.
- The bearer SHALL reach the process through the environment Hermes already forwards (it loads `${HERMES_HOME:-~/.hermes}/.env` and passes it to `mcp_servers.*` subprocesses), never through `args`. A token in an argument vector is readable by any local process via `ps` and `/proc/<pid>/cmdline`.
- The slug SHALL be expressed as `REMBRIC_PROJECT_SLUG` in the environment, not as a `/mcp/<slug>` URL suffix. With no URL argument the environment variable is the only way to express a default slug — and it is the variable this plugin's own `requires_env` already collects, resolved by the bridge with the same precedence this capability's cascade defines (`.rembric` first, the environment variable second).

Any `node`-instead-of-`npx` variant the README shows SHALL point at a current path; the pre-monorepo `plugin/bin/…` path SHALL NOT appear.

The README SHALL NOT mention `~/.rembric/.env`, `${XDG_CONFIG_HOME}/rembric/.env`, `get_config_schema`, `save_config`, or `~/.hermes/rembric.json`. Those mechanisms were removed; documenting them would mislead users into setting up files the plugin ignores.

The repository's root `README.md` SHALL be updated to list Hermes Agent under "Supported clients" alongside Claude Code, Codex CLI, and opencode, with a link to the plugin README at `apps/plugin/.hermes-plugin/README.md`.

`docs/agents.md` SHALL gain (or retain, after path swap) a "Hermes Agent" section mirroring the structure of the existing Claude Code and Codex CLI sections, leading with the TUI installer and covering install (including the `requires_env` prompt flow as the manual fallback), config, env vars, slug resolution, and a pointer to the plugin README at the new path.

That section's `mcp_servers.rembric` block SHALL satisfy the same four properties as the plugin README's, since it is the same block shown twice.

`apps/plugin/README.md` and `apps/plugin/CHANGELOG.md` SHALL be updated to include Hermes alongside the other clients.

#### Scenario: README leads with the TUI, manual curl-installer retained below

- **WHEN** a user reads `apps/plugin/.hermes-plugin/README.md` top-to-bottom
- **THEN** the first install instruction SHALL be the TUI installer
- **AND** the `curl … install.sh | sh` + `hermes plugins install rembric` flow SHALL appear under an explicit "Manual install" heading

#### Scenario: README pairs provider and bridge in the config example

- **WHEN** a user reads `apps/plugin/.hermes-plugin/README.md` end-to-end
- **THEN** the first config block they see registers BOTH the `mcp_servers.rembric` entry (bridge) AND the `memory.provider: rembric` entry (provider) in the same `~/.hermes/config.yaml` snippet
- **AND** the prose preceding the block explicitly notes that lifecycle (provider) and tool access (bridge) are complementary, not redundant
- **AND** the README contains no reference to `~/.rembric/.env` or `get_config_schema`

#### Scenario: The documented MCP block pins an exact transport version

- **WHEN** every `mcp_servers.rembric` block in `apps/plugin/.hermes-plugin/README.md` and `docs/agents.md` is read
- **THEN** each SHALL name `@rembric/mcp-bridge@<x.y.z>` with an exact version
- **AND** no occurrence of `mcp-remote` SHALL remain
- **AND** no `@latest` or other floating tag SHALL appear in either block

#### Scenario: The documented MCP block passes no arguments beyond the specifier

- **WHEN** the `mcp_servers.rembric` block is read
- **THEN** its `args` SHALL be exactly `-y` and the pinned package specifier
- **AND** it SHALL contain no URL entry, no `--header` entry and no `--allow-http` entry

#### Scenario: The documented MCP block keeps the token and the slug in the environment

- **WHEN** the block is read
- **THEN** the bearer SHALL be supplied through the environment Hermes forwards to the subprocess, not through `args`
- **AND** the default project slug SHALL be expressed as `REMBRIC_PROJECT_SLUG`, not as a `/mcp/<slug>` suffix on `REMBRIC_SERVER_URL`

#### Scenario: A per-directory `.rembric` still wins over the documented default

- **GIVEN** a documented block setting `REMBRIC_PROJECT_SLUG=alpha` and a working directory containing `.rembric` with `PROJECT_SLUG=gamma`
- **WHEN** the transport resolves the slug
- **THEN** it SHALL use `gamma`
- **AND** the resolution SHALL match the precedence this capability's slug cascade defines for the provider, so the two surfaces cannot disagree

#### Scenario: No stale bridge path is documented

- **WHEN** any local-checkout alternative to `npx` is shown
- **THEN** it SHALL NOT name the pre-monorepo `plugin/bin/rembric-bridge.mjs` path
